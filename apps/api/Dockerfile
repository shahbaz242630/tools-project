# syntax=docker/dockerfile:1

# Build stage. Needs the whole workspace: @app/api depends on @platform/*, and
# those are built from source here rather than pulled from a registry.
FROM node:24-alpine AS builder

WORKDIR /repo
RUN corepack enable

# Manifests and the lockfile first, so a source-only change reuses the cached
# install layer. Copying source before installing would invalidate it on every
# edit and turn a 5-second rebuild into a 90-second one.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/config/package.json ./packages/config/
COPY packages/observability/package.json ./packages/observability/
COPY apps/api/package.json ./apps/api/

# --ignore-scripts: the root `prepare` hook installs git hooks, which needs a
# .git directory that is deliberately not in the image.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

RUN pnpm --filter @platform/core --filter @platform/config \
    --filter @platform/observability --filter @app/api build

# Resolves the workspace symlinks into a real, self-contained directory. A
# plain `cp -r node_modules` cannot survive the move: pnpm's layout is a tree of
# symlinks into a store that does not exist in the runtime image.
RUN pnpm --filter @app/api deploy --prod --legacy --ignore-scripts /prod/api

# Runtime stage. No pnpm, no compiler, no sources.
FROM node:24-alpine AS runtime

# tini reaps zombies and forwards signals. Without an init, node runs as PID 1,
# where the kernel ignores default signal handlers -- SIGTERM would do nothing
# and every deploy would end in a 10-second SIGKILL instead of a clean drain.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /prod/api ./

# Unprivileged. The `node` user ships with the image.
USER node

EXPOSE 3000

# Liveness only: this must not consult the database. A dependency outage that
# failed the container health check would have Docker restart a perfectly
# healthy process, turning a recoverable failure into a restart loop.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
