# mudroom-support: one container, one vendor, exactly one replica.
# Build:  docker build -t mudroom-support .
# Run:    see README.md (needs a persistent volume at /data and the required env vars).

FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/support.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
# No VOLUME instruction: Railway rejects it, and an anonymous volume doesn't
# survive `docker rm` anyway. Mount a named/platform volume at /data; the
# server warns at startup if DB_PATH sits on the container's own filesystem.
EXPOSE 3000
CMD ["node", "dist/server.js"]
