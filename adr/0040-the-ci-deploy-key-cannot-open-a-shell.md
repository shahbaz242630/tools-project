# 0040. The CI deploy key cannot open a shell

- **Status:** Accepted
- **Date:** 2026-08-09
- **Relates to:** ADR 0009, ADR 0012, ADR 0037, ADR 0039; BRD §10, §14
- **Slice:** 0.9e

## Context

BRD §14's Phase 0 exit gate asks for a change to travel from a branch to staging through green
CI **with no manual secret handling**. Since 9 August every part of that works except the last
clause: the stack deploys, migrates, health-checks and rolls back, and a human runs it.

Closing it means giving GitHub Actions a credential that can reach the box. That is a larger
decision than it appears, for two reasons.

**`deploy` is in the `docker` group, and that is root-equivalent.** Anyone who can talk to the
Docker socket can start a container that mounts `/` and read or write anything on the host. So an
unrestricted SSH key for `deploy` is not "permission to redeploy" — it is permission to do
anything, including reading `/opt/rental/staging.env`, which holds the Neon password, the Clerk
secret key and `PERSONAL_DATA_ENCRYPTION_KEY`.

**This repository is public.** Fork pull requests do not receive secrets, and only a maintainer
can push to `main`, so the exposure is not casual. But the blast radius of a leaked repository
secret is the whole platform, and "the secret store has never been breached" is not a control.

## Decision

**The CI key is restricted to a forced command. It cannot open a shell.**

`/home/deploy/.ssh/authorized_keys` carries:

```
command="/opt/rental/ci-command.sh",restrict ssh-ed25519 AAAA… github-actions-deploy-staging
```

- **`command=`** replaces whatever the client asks for. `ssh deploy@box cat /opt/rental/staging.env`
  runs the wrapper with `cat …` in `SSH_ORIGINAL_COMMAND`, and the wrapper refuses it.
- **`restrict`** disables port forwarding, agent forwarding, PTY allocation, X11 and `~/.ssh/rc`.
  Without it, `-L` would tunnel to anything the box can reach — including Redis, and the Neon
  endpoint using credentials the box already holds.
- **The wrapper accepts four verbs**: `deploy <40-hex-sha>`, `rollback`, `status`,
  `logs <api|web|worker|redis>`. Everything else is refused with a message naming what is allowed.
- **`--env staging` is hardcoded in the wrapper.** The environment is not a parameter, so the CI
  key cannot address production however the workflow is edited. Production will get its own key
  and its own wrapper when it exists.
- **`deploy` syncs the checkout to the SHA first.** The compose file and the images ship in the
  same commit; deploying a new tag against an old `docker-compose.app.yml` is a failure that looks
  like a working deploy. Slice 0.9d changed that file, which is exactly when this bites.
- **The wrapper is version-controlled** at `infra/compose/ci-command.sh`, so a change to what CI
  may do is a reviewed change rather than an edit on a box.

**The workflow triggers on `workflow_run` of Release completing**, not on `push`. A push to `main`
starts Release and Deploy simultaneously, and Deploy would ask the box for image tags still being
built — a race that presents as a broken deploy.

**Credentials live in a GitHub Environment**, not repository secrets, so a workflow added later
cannot reach them by accident and production can be given approval rules without touching this
design. **The host key is pinned** from the box's own `/etc/ssh/ssh_host_ed25519_key.pub` rather
than `ssh-keyscan`, which trusts whatever answers, and `StrictHostKeyChecking=yes` is explicit.

## Consequences

**A leaked repository secret can redeploy the platform and read its logs. It cannot read a
credential, open a shell, or forward a port.** That is a genuine reduction, not a formality: the
worst case moves from "the attacker owns the box and every secret on it" to "the attacker can
roll staging backwards and forwards between commits that are already public".

**Rollback and log retrieval are wired into the workflow rather than documented.**
`workflow_dispatch` exposes `rollback` and `status` as inputs, and a failed deploy pulls the last
fifteen minutes of `api`, `web` and `worker` logs into the job output. Both are exit-gate
requirements that a green deploy never exercises.

**Four verbs is a small surface, and it will feel too small at some point** — the first time
somebody wants to run a one-off query or restart a single container, they will reach for the
laptop key instead, which is correct. Adding a verb is a pull request, which is the point.

**The wrapper has to be installed on the box before the workflow can work**, and it is not
installed by anything automatic. It was bootstrapped by hand for this slice; the runbook now
carries the step, and reinstalling it from the repository after a change is a manual act. That is
a real gap and a deliberate one: a mechanism that updated the thing constraining CI, driven by
CI, would defeat itself.

**The laptop key still has full shell access** and is unchanged. Two keys with different powers
on the same account is the arrangement — the human keeps a shell, the machine does not.

## Alternatives considered

**An unrestricted key for `deploy`.** What almost every deploy-over-SSH guide describes, and one
line of configuration. Rejected on the blast radius above: with docker-group membership it is
indistinguishable from handing out root, and the secret sits in a public repository's settings.

**A separate `ci` user without docker-group membership**, using `sudo` for specific commands.
Genuinely more granular, and rejected as more moving parts for the same outcome — any rule
permitting `docker compose up` permits mounting the host filesystem, so the `sudoers` file would
have to whitelist the deploy script, at which point it is a forced command with extra steps.

**A pull-based agent on the box** polling the registry for new tags. No inbound credential at all,
which is strictly better on this axis. Rejected for now because it inverts where failures surface:
a deploy that fails is silent until somebody looks at the box, and the exit gate wants the failure
in CI where a human already is. Worth revisiting when alerting exists.

**GitHub's OIDC with a short-lived certificate.** The right long-term answer — no stored private
key at all — and it needs an SSH CA on the box plus certificate issuance. Disproportionate for one
box and one environment. Revisit at the second environment.

## What would change this

Revisit when production exists: it needs its own key, its own wrapper hardcoding `--env production`,
and an approval rule on its environment. Revisit if the verb list grows past roughly six, which
would suggest the boundary is in the wrong place. And revisit in favour of OIDC and an SSH CA the
moment there is more than one box, because rotating a stored key across several is the failure
this design is one step away from.
