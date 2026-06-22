FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY apps/bridge/package.json apps/bridge/package.json
COPY apps/worker/package.json apps/worker/package.json

RUN npm ci

COPY apps/bridge apps/bridge

RUN npm run build:bridge

FROM node:22-bookworm-slim AS node-runtime

FROM ruby:3.3-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN gem install skylight-mcp --no-document

WORKDIR /app

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app/apps/bridge/dist /app/apps/bridge/dist

ENV PORT=8080

CMD ["node", "/app/apps/bridge/dist/index.js"]
