# syntax=docker/dockerfile:1

# Build stage. Needs the whole workspace: @app/web depends on @platform/*, and
# those are compiled from source here rather than pulled from a registry.
FROM node:24-alpine AS builder

WORKDIR /repo
RUN corepack enable

# Everything at once, rather than manifests first for a cached install layer.
# See apps/api/Dockerfile for why that optimisation is not worth its
# maintenance cost here.
#
# --ignore-scripts: the root `prepare` hook installs git hooks, which needs a
# .git directory that is deliberately not in the image.
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts

# `@app/web...` selects the app *and its dependencies*, and pnpm runs them in
# topological order — so @platform/* are compiled by tsc before next build
# tries to resolve their `dist` entry points.
RUN pnpm --filter "@app/web..." build

# Runtime stage. No pnpm, no compiler, no sources.
FROM node:24-alpine AS runtime

# tini reaps zombies and forwards signals. Without an init, node runs as PID 1,
# where the kernel ignores default signal handlers -- SIGTERM would do nothing
# and every deploy would end in a 10-second SIGKILL instead of a clean drain.
RUN apk add --no-cache tini

ENV NODE_ENV=production

# Read by Next's standalone server, which owns these rather than @platform/config
# — see the comment on the web schema in packages/config/src/web-env.ts.
# 0.0.0.0, not localhost: binding loopback inside a container makes the service
# unreachable from the ingress.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app

# `output: 'standalone'` traces only the files actually reached and emits them
# with a minimal node_modules, so this image needs no install step. The layout
# mirrors the repository because outputFileTracingRoot is the workspace root,
# which is why the entry point below is apps/web/server.js rather than server.js.
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./

# Static assets are deliberately excluded from the traced output — nothing
# imports them, so tracing cannot see them. Without this the pages render with
# no CSS and every chunk 404s.
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static

# Unprivileged. The `node` user ships with the image.
USER node

EXPOSE 3000

# Hits the app's own root page, which renders without contacting the API. A
# probe that depended on the API would restart a perfectly healthy web server
# during a database outage, turning one failure into two.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
