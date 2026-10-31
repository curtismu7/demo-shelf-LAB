# The shelf as a read-only catalog of the ONLINE demos (SHELF_ONLINE_ONLY=1): tag filters, search, status lights for the hosted
# sites, planned ideas. No Start / Stop (that needs the host's Docker), no localhost cards. Build the web app, then run the server.
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
ENV NODE_ENV=production SHELF_BIND=0.0.0.0 SHELF_PORT=4400 SHELF_ONLINE_ONLY=1 SHELF_DATA_DIR=/data
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev -w server && npm cache clean --force && mkdir -p /data && chown node:node /data
COPY server/src server/src
COPY data data
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:4400/api/shelf || exit 1
CMD ["node", "server/src/index.js"]
