FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY transcoderworker/package*.json ./transcoderworker/
RUN cd transcoderworker && npm ci --omit=dev

COPY transcoderworker/src ./transcoderworker/src
COPY transcoderapp/workers ./transcoderapp/workers

ENV NODE_ENV=production
CMD ["node", "transcoderworker/src/index.js"]
