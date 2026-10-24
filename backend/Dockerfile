# Official Node 24.21.0 bookworm-slim manifest, verified 2026-10-24.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY backend/src ./src
COPY backend/test/providers/ui-server.mjs ./test/providers/ui-server.mjs
COPY backend/release.json backend/REVISION ./
RUN node --input-type=module -e "import {readRevision} from './src/revision.mjs'; readRevision(true)"
# UID 0 is intentional for Railway's mounted volume ownership.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SAINT_LOOK_DATA_DIR=/data
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "src/start-controlled.mjs"]
