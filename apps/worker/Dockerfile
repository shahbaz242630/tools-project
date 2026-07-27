# syntax=docker/dockerfile:1

# Build stage. Needs the whole workspace: @app/worker depends on @platform/*,
# which are built from source rather than pulled from a registry.
FROM node:24-alpine AS builder

WORKDIR /repo
RUN corepack enable

# Manifests first, so a source-only change reuses the cached install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
COPY packages/runtime/package.json ./packages/runtime/
COPY apps/worker/package.json ./apps/worker/

# --ignore-scripts: the root `prepare` hook installs git hooks and needs a .git
# directory that is deliberately absent from the image.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN pnpm --filter @platform/core --filter @platform/config \
    --filter @platform/observability --filter @platform/runtime \
    --filter @app/worker build

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
