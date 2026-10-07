# syntax=docker/dockerfile:1
# Image de production de Lumière : API + interface compilée + ffmpeg.

# --- 1. Compilation (interface Vite + bundle du serveur) ------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY tools/demo-source/package.json tools/demo-source/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# --- 2. Dépendances de production du serveur uniquement -------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY tools/demo-source/package.json tools/demo-source/
RUN npm ci --omit=dev --workspace @lumiere/server --no-audit --no-fund

# --- 3. Exécution ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8484 \
    DATA_DIR=/data \
    MEDIA_DIR=/media \
    WEB_DIST_DIR=/app/apps/web/dist \
    LOG_PRETTY=false
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data /media && chown -R node:node /data /media
USER node
VOLUME ["/data", "/media"]
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8484) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/main.js"]
