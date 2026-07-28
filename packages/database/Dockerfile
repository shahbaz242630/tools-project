# syntax=docker/dockerfile:1

# Migrations, as their own image.
#
# Separate from the application images on purpose. The API and worker run with
# production dependencies only, so they do not carry the Prisma CLI — and they
# should not: a migration tool sitting in the container that serves traffic is
# weight and attack surface for a job that runs once per deploy.
#
# It exists at all because ADR 0012 says the box never builds. Migrations have
# to arrive as a published artefact like everything else, tagged with the same
# commit SHA, so the schema and the code that expects it can never disagree.
#
# Single stage, and it does not use the pnpm workspace at all — see below.

FROM node:24-alpine AS runtime

RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

# Installed here rather than copied out of a workspace build.
#
# `prisma migrate` needs the schema engine, a native binary that
# @prisma/engines fetches in a postinstall script. Our workspace installs use
# `--ignore-scripts`, so it is never fetched, and `pnpm deploy` does not carry a
# devDependency's transitive packages into its output either. Prisma then tries
# to download it lazily on first use — and the runtime filesystem is read-only,
# so that fails and reports the binary as *missing* rather than as
# undownloadable, which sends you looking in entirely the wrong place.
#
# A plain npm install runs the postinstall, so the engine is baked in and the
# image is self-contained. Pinned exactly: a migration tool that changed version
# between releases on its own is not something anyone wants to debug.
RUN npm install --no-save --omit=dev prisma@7.9.1 && npm cache clean --force

# Only what the CLI reads. No application code, no generated client, no source.
COPY --chown=node:node packages/database/prisma ./prisma
COPY --chown=node:node packages/database/prisma.config.ts ./prisma.config.ts

USER node

# No HEALTHCHECK and no port. This runs to completion and exits; a non-zero exit
# is what aborts the deploy.
ENTRYPOINT ["/sbin/tini", "--"]

# The CLI's entry point directly, not `npx prisma`. Where the bin shim is
# absent, `npx prisma` prints "prisma: not found" and exits 0 — a migration that
# silently does not run, which is the worst failure available here.
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
