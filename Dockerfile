FROM node:22-alpine

WORKDIR /app

COPY soul.md /app/soul.md
COPY cartridge.yaml /app/cartridge.yaml
COPY bench.yaml /app/bench.yaml
COPY worker.mjs /app/worker.mjs

ENV MEMORY_DIR=/tmp/rosie-mind
USER node
CMD ["node", "/app/worker.mjs"]
