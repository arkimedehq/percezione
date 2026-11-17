# syntax=docker/dockerfile:1
# Percezione: perception-service (Node) and its frontend in one image. Same layout as the repo, so the service finds
# frontend/dist and data/ where it does in development: /app/perception-service, /app/frontend/dist, /app/data.

# --- the service's dependencies and sources (the frontend imports its types)
FROM node:24-bookworm-slim AS service
WORKDIR /app/perception-service
COPY perception-service/package.json perception-service/package-lock.json ./
RUN npm ci
COPY perception-service/ ./
# to JavaScript: no tsx at run time; the .ts imports become .js
RUN npx tsc -p tsconfig.json --noEmit false --outDir out --rootDir . --rewriteRelativeImportExtensions

# --- tests: docker build --target test .
FROM service AS test
RUN npm test

# --- frontend
FROM service AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- the image
FROM node:24-bookworm-slim
ENV NODE_ENV=production
# ffmpeg: the short memory of the cameras (src/buffer.ts)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app/perception-service
COPY perception-service/package.json perception-service/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=service /app/perception-service/out/src ./src
COPY perception-service/config ./config
COPY --from=frontend /app/frontend/dist /app/frontend/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
# UI and API; Frigate's UI behind the same login
EXPOSE 8090 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.UI_PORT || 8090) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "src/index.js"]
