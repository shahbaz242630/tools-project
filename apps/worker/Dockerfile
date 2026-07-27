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

# No HEALTHCHECK and no exposed port. The worker serves no traffic, and a
# liveness probe asserting only "the process exists" would be worse than none:
# it reads as healthy while the worker sits disconnected from Redis processing
# nothing. Queue depth and job-completion rate are the real signals, and they
# belong in monitoring rather than in a container probe. Revisit in Phase 0.9
# when there is somewhere to send metrics.

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
