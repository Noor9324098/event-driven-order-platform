# One parameterised image recipe for all four services.
# Build from the repo root:  docker build -f docker/service.Dockerfile --build-arg SERVICE=order-service .
FROM node:22-alpine
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY libs/common/package.json libs/common/
COPY services/order-service/package.json services/order-service/
COPY services/inventory-service/package.json services/inventory-service/
COPY services/payment-service/package.json services/payment-service/
COPY services/notification-service/package.json services/notification-service/
RUN npm ci --omit=dev

COPY libs libs
COPY services/${SERVICE} services/${SERVICE}

USER node
CMD ["sh", "-c", "node --no-warnings services/${SERVICE}/src/index.js"]
