# syntax=docker/dockerfile:1.7

FROM node:22.13.0-bookworm-slim AS build
WORKDIR /app/test-shop
RUN chown -R node:node /app
USER node
COPY --chown=node:node . /app/test-shop

RUN npm ci \
    && npm run build \
    && npm prune --omit=dev

FROM node:22.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/test-shop
COPY --from=build --chown=node:node /app/test-shop /app/test-shop
USER node

FROM runtime AS shop-host
EXPOSE 3000
CMD ["node", "apps/shop-host/dist/main.js"]

FROM runtime AS shop-warehouse
EXPOSE 8081
CMD ["node", "apps/shop-warehouse/dist/main.js"]

FROM runtime AS shop-payment
EXPOSE 8082
CMD ["node", "apps/shop-payment/dist/main.js"]
