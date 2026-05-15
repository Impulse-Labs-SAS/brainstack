# =============================================================================
# BrainStack — multi-stage Dockerfile
# Stage 1: install deps + build all workspaces.
# Stage 2: minimal runtime image with only the built server.
# Real server + web build wired in Fases 2 and 4. This file already produces a
# working image whose entrypoint runs the Fase 0 stub.
# =============================================================================

# ---- Stage 1: build ----------------------------------------------------------
FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/skill/package.json ./packages/skill/

RUN pnpm install --frozen-lockfile || pnpm install

# Copy the rest of the sources and build.
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm -r build

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=builder /app/apps/server/package.json ./apps/server/
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/packages/core/node_modules ./packages/core/node_modules

EXPOSE 3000

CMD ["node", "apps/server/dist/index.js"]
