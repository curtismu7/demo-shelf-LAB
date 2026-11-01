# The shelf in a container: non-root, read-only filesystem, no Docker socket. It cannot reach your demos on 127.0.0.1 (that is the
# container), so it connects to the host (host.docker.internal) with each demo's own Host header, and it asks the start agent running
# on your machine (npm run agent) to do docker compose up / down. Start it with `npm run docker`, which supplies the settings below.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web web
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production SHELF_IN_DOCKER=1 SHELF_BIND=0.0.0.0 SHELF_PORT=4400 SHELF_DATA_DIR=/data SHELF_PROBE_HOST=host.docker.internal SHELF_AGENT_URL=http://host.docker.internal:4405
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev -w server && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY server/src server/src
COPY data data
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:4400/api/health || exit 1
CMD ["node", "server/src/index.js"]
