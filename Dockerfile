FROM public.ecr.aws/docker/library/ruby:3.3-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs \
  && rm -rf /var/lib/apt/lists/*

# Pinned so a future gem release cannot change tool behaviour under a running
# investigation. Bump deliberately after re-running the concurrency tests.
ARG SKYLIGHT_MCP_VERSION=0.1.0
RUN gem install skylight-mcp --version "${SKYLIGHT_MCP_VERSION}" --no-document

WORKDIR /app

COPY apps/bridge/dist /app/apps/bridge/dist

ENV PORT=8080

CMD ["node", "/app/apps/bridge/dist/index.js"]
