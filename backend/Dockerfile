# The default CI image has no checkpoint downloads. The reviewed live workflow
# explicitly selects model-runtime after the separate memory approval.
ARG SAINT_LOOK_RUNTIME=application
FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS python-runtime
# Official Node 24.21.0 bookworm-slim manifest, verified 2026-10-24.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS application
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY backend/src ./src
COPY backend/ml ./ml
COPY backend/test/providers/ui-server.mjs backend/test/providers/jev.mjs backend/test/providers/model.mjs ./test/providers/
COPY shared/wardrobe-taxonomy.json /app/shared/wardrobe-taxonomy.json
COPY backend/release.json backend/REVISION ./
RUN node --input-type=module -e "import {readRevision} from './src/revision.mjs'; readRevision(true)"
# UID 0 is intentional for the mounted volume's root ownership.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SAINT_LOOK_DATA_DIR=/data
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "src/start-release.mjs"]

FROM application AS model-runtime
# Both images use bookworm/glibc. Copy the pinned interpreter, then install its
# shared-library dependencies without replacing the already pinned Node runtime.
COPY --from=python-runtime /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libbz2-1.0 libexpat1 libffi8 libgdbm6 liblzma5 libncursesw6 libreadline8 \
    libsqlite3-0 libssl3 zlib1g libgomp1 \
    && rm -rf /var/lib/apt/lists/* && ldconfig
RUN python3.12 -m venv /opt/saint-look-ml \
    && /opt/saint-look-ml/bin/pip install --no-cache-dir torch==2.6.0 torchvision==0.21.0 \
       --index-url https://download.pytorch.org/whl/cpu \
    && /opt/saint-look-ml/bin/pip install --no-cache-dir -r ml/requirements.txt \
    && /opt/saint-look-ml/bin/python ml/fetch_assets.py /opt/saint-look-model
ENV SAINT_LOOK_MODEL_PROFILE=outfit-transformer-labse-v1 \
    SAINT_LOOK_MODEL_ASSETS=/opt/saint-look-model \
    SAINT_LOOK_MODEL_PYTHON=/opt/saint-look-ml/bin/python \
    SAINT_LOOK_MODEL_THREADS=1 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

FROM ${SAINT_LOOK_RUNTIME} AS release
