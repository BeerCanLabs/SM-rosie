# Rosie runs under the factory shim (@beercanlabs/factory-hydrate), which pulls her mind into $MEMORY_DIR, points
# egress at the gatekeeper-egress (sets FACTORY_MODEL_BASE_URL, DISCORD_BASE_URL, ...), heartbeats, runs `node worker.mjs`,
# reports the result file, and pushes the mind back (DESIGN_AUTHORITY §6.6).

# ---- Stage 1: build the factory shim from a pinned agent-factory commit ----
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS shim
ARG AGENT_FACTORY_REF=6c9f8576f72f060c91c35e523fef48b9f0702c31
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q agent-factory \
    && cd agent-factory \
    && git remote add origin https://github.com/BeerCanLabs/agent-factory.git \
    && git fetch -q --depth 1 origin "${AGENT_FACTORY_REF}" \
    && git checkout -q FETCH_HEAD
WORKDIR /src/agent-factory
RUN npm ci --ignore-scripts -w @beercanlabs/factory-hydrate \
    && npm run build -w @beercanlabs/factory-hydrate

# ---- Stage 2: Rosie ----
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# AWS CLI for the shim's mind sync (platform traffic, E6), in its own virtualenv. Rosie's code never uses it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/awscli \
    && /opt/awscli/bin/pip install --no-cache-dir awscli \
    && ln -s /opt/awscli/bin/aws /usr/local/bin/aws

COPY --from=shim /src/agent-factory/packages/hydrate/package.json /opt/factory-hydrate/package.json
COPY --from=shim /src/agent-factory/packages/hydrate/dist /opt/factory-hydrate/dist

WORKDIR /app
COPY package.json soul.md cartridge.yaml bench.yaml worker.mjs ./

ENV MEMORY_DIR=/tmp/rosie-mind
USER node
ENTRYPOINT ["node", "/opt/factory-hydrate/dist/shim.js", "--"]
CMD ["node", "worker.mjs"]
