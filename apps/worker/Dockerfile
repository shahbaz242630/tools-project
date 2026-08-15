# syntax=docker/dockerfile:1

# Build stage. Needs the whole workspace: @app/worker depends on @platform/*,
# which are compiled from source rather than pulled from a registry.
FROM node:24-alpine AS builder

WORKDIR /repo
RUN corepack enable

# Everything at once rather than manifests first — see apps/api/Dockerfile for
# why the cached-install-layer optimisation is not worth its maintenance cost
# here.
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts

# `@app/worker...` selects the app *and its dependencies*.
RUN pnpm --filter "@app/worker..." build

# Resolves pnpm's symlink tree into a real self-contained directory. A plain
# copy cannot survive the move between stages.
RUN pnpm --filter @app/worker deploy --prod --legacy --ignore-scripts /prod/worker

# Runtime stage. No pnpm, no compiler, no sources.
FROM node:24-alpine AS runtime

# tini reaps zombies and forwards signals. As PID 1 without an init, node would
# not receive SIGTERM at all, so every deploy would SIGKILL a worker mid-job --
# and an interrupted job is re-delivered, which for anything not idempotent is
# worse than waiting for it to finish.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /prod/worker ./

USER node

# No exposed port: the worker serves no traffic.
#
# It had no HEALTHCHECK either until 15 August 2026, and the argument for that
# was half right. A probe asserting only "the process exists" *is* worse than
# none — it reads healthy while the worker sits disconnected from Redis
# processing nothing. But the conclusion did not follow: with no probe at all,
# compose's `--wait` accepts "running", so a worker that crash-looped or never
# reached its broker deployed as a success and `scripts/deploy.mjs` never asked.
#
# So this is not a "process exists" probe. `src/main.ts` rewrites the file below
# every HEALTH_INTERVAL_MS, and only after a command has returned over the
# worker's own Redis connection — the same connection it takes jobs on. A stale
# file therefore means a wedged event loop, an unreachable broker, or a process
# that keeps restarting, which is exactly the set of failures that used to deploy
# green. Queue depth and job-completion rate are still the richer signals and
# still belong in monitoring; this is the one a deploy can gate on.
#
# 60s is six write intervals. Wide enough that a slow probe during a reconnection
# is not an outage, narrow enough that a deploy's readiness poll sees the
# failure. scripts/lib/worker-health-budget.test.mjs asserts that relationship,
# because the interval is in TypeScript and the bound is in this shell string and
# nothing else compares them.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const{lstatSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');const age=Date.now()-lstatSync(join(tmpdir(),'worker-health')).mtimeMs;if(age>60000)throw new Error('health signal is '+Math.round(age/1000)+'s old')"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
