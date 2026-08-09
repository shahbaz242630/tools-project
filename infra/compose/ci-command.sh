#!/bin/sh
# Forced command for the CI deploy key. See ADR 0040.
#
# The key that GitHub Actions holds is restricted to this script in
# authorized_keys, so an `ssh deploy@box <anything>` runs *this* and never a
# shell. That matters more than it looks: `deploy` is in the `docker` group,
# which is root-equivalent on any box, and this repository is public — a leaked
# repository secret would otherwise own the machine rather than merely be able
# to redeploy it.
#
# Four verbs, and `staging` is hardcoded into every one of them. The CI key
# cannot address production even if the workflow asks it to.
#
# Installed at /opt/rental/ci-command.sh. It is version-controlled so that a
# change to what CI may do is a reviewed change, not an edit on a box.

set -eu

REPO=/opt/rental/repo
ENVIRONMENT=staging

refuse() {
  echo "ci-command: refused: $1" >&2
  echo "ci-command: allowed: deploy <40-char-sha> | rollback | status | logs [service]" >&2
  exit 2
}

# Word-splitting is deliberate: SSH_ORIGINAL_COMMAND is a single string and the
# verb and argument are separated by a space. Every value that reaches a command
# below is validated against a pattern first, so nothing here is passed through
# unchecked.
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
action="${1:-}"

case "$action" in
  deploy)
    sha="${2:-}"
    # The same rule scripts/deploy.mjs enforces, applied before anything runs.
    # Checked here as well because this is the boundary a stranger reaches.
    echo "$sha" | grep -qE '^[0-9a-f]{40}$' || refuse "deploy needs a full 40-character commit SHA"

    # The box's checkout has to match what is being deployed: the compose file,
    # and any change to it, ships in the same commit as the images. Deploying a
    # new tag against an old compose file is the failure this prevents, and it
    # would look like a working deploy.
    git -C "$REPO" fetch --quiet origin
    git -C "$REPO" checkout --quiet --detach "$sha" || refuse "commit $sha is not in origin"

    exec node "$REPO/scripts/deploy.mjs" --env "$ENVIRONMENT" --tag "$sha" --timeout 240
    ;;

  rollback)
    exec node "$REPO/scripts/deploy.mjs" --env "$ENVIRONMENT" --rollback
    ;;

  status)
    exec node "$REPO/scripts/deploy.mjs" --env "$ENVIRONMENT" --status
    ;;

  logs)
    service="${2:-api}"
    # A closed list rather than a pattern. `logs.mjs` validates its own input,
    # but this is the layer where an unexpected value should stop.
    case "$service" in
      api|web|worker|redis) ;;
      *) refuse "logs: unknown service '$service'" ;;
    esac
    exec node "$REPO/scripts/logs.mjs" --env "$ENVIRONMENT" --service "$service" --since 15m
    ;;

  '')
    refuse "no command (this key does not open a shell)"
    ;;

  *)
    refuse "unknown command '$action'"
    ;;
esac
