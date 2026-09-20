FROM node:22-alpine

RUN apk add --no-cache aws-cli
WORKDIR /app

COPY soul.md /agent/soul.md
COPY surface.yaml /agent/surface.yaml
COPY secrets.manifest.yaml /agent/secrets.manifest.yaml
COPY worker.mjs /app/worker.mjs

ENV MEMORY_DIR=/tmp/rosie-mind
USER node
CMD ["node", "/app/worker.mjs"]
