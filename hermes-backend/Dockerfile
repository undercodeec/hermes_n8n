# Build stage
FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# Production stage
FROM node:22-bookworm-slim AS production

WORKDIR /app

ARG GIT_COMMIT
RUN if ! printf '%s' "$GIT_COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then \
      echo 'GIT_COMMIT must be the full lowercase Git SHA (40 hex characters)' >&2; \
      exit 1; \
    fi
LABEL org.opencontainers.image.revision="${GIT_COMMIT}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3003

CMD ["node", "dist/main.js"]
