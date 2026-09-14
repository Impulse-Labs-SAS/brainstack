# =============================================================================
# BrainStack — Docker images
#
# One Dockerfile, two images, selected with --target:
#
#   server  the API, auth, tRPC and MCP endpoint (Hono), on :3000
#   web     the Next.js app, on :3000
#
# docker-compose.yml builds both and puts Caddy in front, so the browser sees a
# single origin: /api and /.well-known go to the server, everything else to the
# web app — the same layout Netlify serves in production.
# =============================================================================

# ---- build: install everything and compile every workspace ------------------
FROM node:20-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

# Manifests first, so a source change does not reinstall dependencies.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/skill/package.json ./packages/skill/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

# core first: server and web both resolve @brainstack/core to its compiled dist/.
RUN pnpm --filter @brainstack/core build \
 && pnpm --filter @brainstack/server build \
 && BRAINSTACK_STANDALONE=1 pnpm --filter @brainstack/web build

# ---- server-deploy: the server with its production dependencies only --------
FROM build AS server-deploy

# `pnpm deploy` copies core in as a real package rather than a workspace link.
# A filtered `pnpm install --prod` looks like the same thing and is not: with the
# hoisted layout it installs every workspace's dependencies, Next.js included,
# and the image comes out at a gigabyte.
RUN pnpm --filter @brainstack/server deploy --prod --legacy /deploy

# ---- server -----------------------------------------------------------------
FROM node:20-bookworm-slim AS server

ENV NODE_ENV=production
WORKDIR /app

COPY --from=server-deploy /deploy/package.json ./
COPY --from=server-deploy /deploy/dist ./dist
COPY --from=server-deploy /deploy/node_modules ./node_modules
# Served by the MCP `get_brainstack_guide` tool, which reads it from disk.
COPY --from=build /app/packages/skill/INSTRUCTIONS.md ./packages/skill/

USER node
EXPOSE 3000
CMD ["node", "dist/serve.js"]

# ---- web --------------------------------------------------------------------
FROM node:20-bookworm-slim AS web

ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone server binds to the container hostname unless told otherwise,
# which Caddy, on another container, cannot reach.
ENV HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
