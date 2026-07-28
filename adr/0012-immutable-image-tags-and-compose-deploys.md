# 0012. Deploy immutable image tags from GHCR, run them with Compose behind Caddy

- **Status:** Accepted
- **Date:** 2026-07-28
- **Relates to:** BRD §14 (Phase 0 exit gate), §12.4 — builds on [0009](0009-self-hosted-vps-with-off-box-backups.md)

## Context

ADR 0009 settled where things run: a self-hosted KVM VPS with Docker Compose, staging and production on one box. It did not settle how a commit becomes a running process, or how that is undone.

The Phase 0 exit gate requires rollback to be demonstrated, and that requirement is what drives the decision. Two constraints follow from it.

**Rollback must not involve a build.** A box that builds is a box where rollback takes minutes, needs the toolchain and the full dependency tree present, and can fail for reasons unrelated to the release being rolled back — a transient registry error during `pnpm install`, or a full disk. Those are all things you discover at the worst moment.

**What is running must be traceable to a commit.** If the box builds from a working copy, or pulls a moving tag, the answer to "what is deployed" is whatever the filesystem happened to contain. After an incident that question has to have an exact answer.

There is also a smaller constraint from ADR 0009: two environments on one machine, and only one process can hold ports 80 and 443.

## Decision

**CI publishes, the box only pulls.** `.github/workflows/release.yml` builds `api` and `worker` on every commit to `main` and pushes them to GHCR. Compose files reference images by tag and never declare `build:`.

**The only tag is the full 40-character commit SHA.** No `latest`, no branch tags, no semantic versions. `scripts/deploy.mjs` rejects anything else, including an abbreviated SHA.

**Deploy is re-pointing, not rebuilding.** A deploy sets `IMAGE_TAG`, brings the stack up, and polls `/ready` until it passes or a timeout expires. On failure it re-points at the previous tag automatically. A rollback is the same operation with an older tag, so it costs an image pull at most, and nothing at all when the image is still cached.

**Release state is persisted per environment** at `${RELEASE_ROOT}/state/<env>.json`: the current tag and an ordered history. Rollback walks backwards through it. It is written only after a release passes its health check, so the recorded release is always one that actually served traffic.

**One shared Caddy terminates TLS** and routes by hostname to `rental-<env>-api`. Application stacks publish no host ports at all — not the API, and certainly not Postgres or Redis.

## Consequences

Rollback is one command and a container restart. It needs no toolchain, no network if the image is cached, and no correct working copy.

Every running container names the commit it came from, in `docker ps`.

**There is no `latest`, so deploying requires knowing a SHA.** This is deliberate friction and it is mildly annoying: `git rev-parse origin/main` is an extra step, and the Release workflow's summary prints the command as a convenience. The alternative makes "what was running when this broke" permanently unanswerable.

**Deploys are not zero-downtime.** Compose stops the old API container before starting the new one, so there is a gap of a few seconds. Acceptable at pilot scale and not beyond it; fixing it properly means a second replica and a proxy that drains, which is an orchestrator's job.

**GHCR becomes a dependency of deploying forwards.** Rolling _back_ still works during a registry outage, because a previously deployed image is already on the box and the deploy pulls only when the image is missing.

**Images accumulate.** Deploys prune dangling images only — never tagged ones, because a tagged image is a rollback target. Reclaiming space is a deliberate act.

**Caddy's certificate volume is now durable state.** Let's Encrypt allows five identical certificates per week; a stack that loses that volume repeatedly gets locked out of TLS for days. It is not in the ADR 0009 backup obligation, because unlike the ledger it can be reconstructed — but not quickly.

**Images are public**, because the repository is. No new exposure: the source is already public, and `.dockerignore` keeps `.env` out of every layer. It does make "no secrets in an image" a property to verify rather than assume.

## Alternatives considered

**A `latest` tag with pull-based deploys (Watchtower or similar).** The least work: the box notices a new image and restarts itself. Rejected because it makes rollback impossible without a rebuild, and because a moving tag means two boxes running "the same version" can be running different code.

**Build on the box — `git pull && docker compose up --build`.** Simplest to set up and needs no registry. Rejected on both constraints above: minutes-long rollbacks and untraceable running code. It also puts the full build toolchain on the machine serving production traffic.

**nginx with certbot.** Familiar, and the configuration is more widely understood. Rejected because renewal becomes a cron job whose failure is silent until the certificate expires — a class of outage Caddy removes entirely by renewing in-process.

**Traefik.** Routes from container labels, so a new environment needs no central file. Rejected for a two-route box: the configuration ends up spread across compose labels, and "why is this route not working" becomes a hunt. One Caddyfile can be read top to bottom.

**Kamal, Docker Swarm or k3s.** All give genuine zero-downtime rollouts and health-gated deploys that this does not. Rejected as an orchestrator's worth of concepts and failure modes for two applications on one machine, with one engineer. The deploy script here is roughly 300 lines and its behaviour is entirely inspectable.

**Docker Hub instead of GHCR.** Rejected for anonymous pull rate limits — which bite exactly when a box is rebuilt — and a second account to hold credentials for. GHCR authenticates with the workflow token that already exists.

## What would change this

A second box, or a requirement for genuinely zero-downtime deploys, makes the orchestrator question live again — Kamal is the smallest step from here and keeps the immutable-tag model.

If manual SHA entry becomes real friction, add a convenience that resolves `origin/main` to a SHA at deploy time. That preserves the invariant; a `latest` tag would not.

If images ever need to be private — a licensed dependency baked in, say — GHCR supports it, but the box then needs a registry credential and this ADR's "no secrets on the box beyond the env file" gets a footnote.
