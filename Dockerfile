FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
RUN mkdir -p /data/queue /data/receipts && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.mjs"]
