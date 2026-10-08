FROM node:22-alpine

WORKDIR /app
# node:sqlite works but is labelled experimental; hide its warning from logs and commands.
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"
# Dependencies first, so code changes reuse the cached install. The lockfile pins versions.
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY dashboard/server.js dashboard/history.js dashboard/sharelog.js dashboard/pool-api.js dashboard/auth.js dashboard/reset-password.js ./
COPY dashboard/public ./public

EXPOSE 8080
CMD ["node", "server.js"]
