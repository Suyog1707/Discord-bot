# Bot image for VPS deployment (docs/DEPLOYMENT.md).
#
# Build from the repo root so the workspace lockfile is in context:
#   docker build -f apps/bot/Dockerfile -t discord-music-bot .

# --- Stage 1: install dependencies -------------------------------------------
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app

# Copy only manifests first so this layer caches until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/bot/package.json ./apps/bot/
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/

RUN pnpm install --frozen-lockfile

# --- Stage 2: build ----------------------------------------------------------
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules
COPY . .

RUN pnpm --filter @discord-music/database run generate \
 && pnpm --filter @discord-music/bot... run build

# Drop dev dependencies from the tree that ships. `deploy` accepts exactly one
# project — its workspace dependencies are bundled in automatically, so the
# `...` suffix (which selects bot+shared+database and makes pnpm bail with
# ERR_PNPM_CANNOT_DEPLOY_MANY) must not be used here.
RUN pnpm --filter @discord-music/bot --prod deploy --legacy /output

# `prisma generate` writes the client into `.prisma` beside @prisma/client in
# pnpm's virtual store, and `deploy` installs that package fresh — without this
# copy the runtime resolves the ungenerated stub and crashes at import with
# "Named export 'LoopMode' not found".
RUN SRC="$(find /app/node_modules/.pnpm -maxdepth 3 -type d -name .prisma | head -n 1)" \
 && DST="$(find /output/node_modules/.pnpm -maxdepth 1 -type d -name '@prisma+client@*' | head -n 1)/node_modules" \
 && cp -R "$SRC" "$DST/"

# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Run unprivileged; `node` (uid 1000) is created by the base image.
COPY --from=builder --chown=node:node /output ./
COPY --from=builder --chown=node:node /app/apps/bot/dist ./dist

USER node

# The bot exposes no ports; readiness is its own gateway connection.
# Use `docker inspect` / logs for health, or add an HTTP probe in a later phase.
CMD ["node", "dist/index.js"]
