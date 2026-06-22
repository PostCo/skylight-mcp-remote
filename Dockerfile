FROM public.ecr.aws/docker/library/ruby:3.3-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN gem install skylight-mcp --no-document

WORKDIR /app

COPY apps/bridge/dist /app/apps/bridge/dist

ENV PORT=8080

CMD ["node", "/app/apps/bridge/dist/index.js"]
