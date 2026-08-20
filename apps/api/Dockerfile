# TokenLayer API — Fastify + Prisma (SQLite), run via tsx.
# Build context is the REPO ROOT (pnpm workspace), not apps/api.
FROM node:20-slim

# Prisma needs OpenSSL at generate- and run-time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Pin pnpm to a 9.x that matches lockfileVersion 9.0.
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app
COPY . .

# Install only the api and its workspace deps (core, adapters) — no contracts/hardhat.
RUN pnpm install --frozen-lockfile --filter "@tokenlayer/api..."

# Generate the Prisma client (downloads the engine for this platform).
# A placeholder URL satisfies schema env() resolution; the real one is set at runtime.
ENV DATABASE_URL="file:./dev.db"
RUN pnpm --filter @tokenlayer/api exec prisma generate

WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 4000

# Apply schema, idempotently seed, then start the server.
CMD ["sh", "-c", "pnpm exec prisma db push --skip-generate --accept-data-loss && pnpm exec tsx src/shared/seed.ts && pnpm exec tsx src/server.ts"]
