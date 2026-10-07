FROM node:22-alpine

WORKDIR /app
COPY dashboard/server.js ./server.js
COPY dashboard/history.js ./history.js
COPY dashboard/public ./public

EXPOSE 8080
CMD ["node", "server.js"]