/**
 * Argument handling for `scripts/logs.mjs`.
 *
 * Pure, and tested, because the failure mode here is silence. A `--since` value
 * Docker does not understand, or a service name that does not exist in the
 * stack, returns zero lines and exit code 0 — indistinguishable from "nothing
 * was logged", which during an incident is exactly the wrong conclusion.
 */

export class LogArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogArgsError';
  }
}

/** Services in docker-compose.app.yml, plus the separate ingress stack. */
export const APP_SERVICES = ['web', 'api', 'worker', 'postgres', 'redis'];
export const ENVIRONMENTS = ['staging', 'production', 'ingress'];

/**
 * What Docker accepts for `--since`: either a duration like `45m` or an RFC 3339
 * timestamp. Anything else is silently treated as "the beginning of time",
 * which returns the whole log and looks like the filter worked.
 */
const DURATION = /^\d+(ns|us|ms|s|m|h)$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const USAGE = `
Usage:
  node scripts/logs.mjs --env <staging|production|ingress> [options]

Options:
  --env <name>       Required. Which stack to read.
  --service <name>   One of ${APP_SERVICES.join(', ')}. Default: all of them.
                     Ignored for --env ingress, which has one service.
  --since <when>     A duration (30m, 2h) or an RFC 3339 timestamp.
                     Default 1h.
  --tail <n>         Lines per service, or "all". Default 500.
  --follow           Stream new lines until interrupted.
  --out <path>       Also write to a file, for taking off the box.

Examples:
  node scripts/logs.mjs --env production --service api --since 15m
  node scripts/logs.mjs --env staging --follow
  node scripts/logs.mjs --env production --since 2h --tail all --out incident.log
`.trim();

export function parseLogArgs(argv) {
  const options = {
    env: null,
    service: null,
    since: '1h',
    tail: '500',
    follow: false,
    out: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const requireValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new LogArgsError(`${arg} needs a value.\n\n${USAGE}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--env':
        options.env = requireValue();
        break;
      case '--service':
        options.service = requireValue();
        break;
      case '--since':
        options.since = requireValue();
        break;
      case '--tail':
        options.tail = requireValue();
        break;
      case '--follow':
        options.follow = true;
        break;
      case '--out':
        options.out = requireValue();
        break;
      case '--help':
      case '-h':
        return { ...options, help: true };
      default:
        throw new LogArgsError(`Unrecognised option "${arg}".\n\n${USAGE}`);
    }
  }

  if (options.env === null) {
    throw new LogArgsError(`--env is required.\n\n${USAGE}`);
  }
  if (!ENVIRONMENTS.includes(options.env)) {
    throw new LogArgsError(
      `--env must be one of ${ENVIRONMENTS.join(', ')}, not "${options.env}".`,
    );
  }

  if (options.service !== null && !APP_SERVICES.includes(options.service)) {
    throw new LogArgsError(
      `--service must be one of ${APP_SERVICES.join(', ')}, not "${options.service}".`,
    );
  }

  if (!DURATION.test(options.since) && !RFC3339.test(options.since)) {
    throw new LogArgsError(
      `--since "${options.since}" is neither a duration nor a timestamp.\n` +
        `Docker would ignore it and return the entire log, which reads like the ` +
        `filter worked.\n` +
        `  durations:  45s, 30m, 2h\n` +
        `  timestamps: 2026-07-28T09:30:00Z`,
    );
  }

  if (options.tail !== 'all' && !/^\d+$/.test(options.tail)) {
    throw new LogArgsError(`--tail must be a whole number or "all".`);
  }

  if (options.follow && options.out !== null) {
    // `--follow` never returns, so the file would be written to indefinitely
    // and never closed. Redirect the stream instead if that is really wanted.
    throw new LogArgsError(
      `--follow and --out cannot be combined: the file would never be finished.`,
    );
  }

  return options;
}

/** The `docker compose logs` arguments for a parsed set of options. */
export function buildLogArgs(options) {
  const args = [
    'logs',
    '--timestamps',
    '--since',
    options.since,
    '--tail',
    options.tail,
  ];

  // Streaming to a terminal only. With --no-follow (the default) compose exits
  // once it has printed what exists.
  if (options.follow) args.push('--follow');

  // Ingress is a single-service stack, so a service filter would only ever
  // exclude the one thing there is to read.
  if (options.service !== null && options.env !== 'ingress') {
    args.push(options.service);
  }

  return args;
}
