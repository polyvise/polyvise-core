FROM node:22-slim AS app

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

ARG APP_WORKSPACE
ARG APP_DIR
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_DEPLOY_CHANNEL

ENV APP_WORKSPACE=${APP_WORKSPACE}
ENV APP_DIR=${APP_DIR}
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
ENV NEXT_PUBLIC_DEPLOY_CHANNEL=${NEXT_PUBLIC_DEPLOY_CHANNEL}

COPY package.json package-lock.json ./
COPY apps/polyvise-web/package.json apps/polyvise-web/package.json
COPY apps/debatefrog-web/package.json apps/debatefrog-web/package.json
COPY packages/debate-engine/package.json packages/debate-engine/package.json

RUN npm ci

COPY . .

RUN test -n "$APP_WORKSPACE"
RUN test -n "$APP_DIR"
RUN npm run build -w "$APP_WORKSPACE"

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["sh", "-c", "cd \"$APP_DIR\" && ../../node_modules/.bin/next start --hostname \"${HOSTNAME:-0.0.0.0}\" --port \"${PORT:-8080}\""]
