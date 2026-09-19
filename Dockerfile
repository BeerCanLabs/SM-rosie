FROM ghcr.io/beercanlabs/factory-agent-generic:latest

COPY soul.md /agent/soul.md
COPY surface.yaml /agent/surface.yaml
COPY secrets.manifest.yaml /agent/secrets.manifest.yaml

# The underlying runtime will parse these files and bootstrap the LLM persona.
