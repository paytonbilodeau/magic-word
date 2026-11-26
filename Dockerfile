FROM node:24-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /app
COPY package*.json ./
COPY scripts/ scripts/
COPY templates/ templates/
COPY src/ src/
COPY schema.sql .
COPY migrations/ migrations/
COPY mcp/ mcp/
COPY examples/ examples/
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/.magic-word /data && chown node:node /app/.magic-word /data
USER node
ENV MAGICWORD_DATA_DIR=/data
EXPOSE 8791
CMD ["node","scripts/host.mjs","--live"]
