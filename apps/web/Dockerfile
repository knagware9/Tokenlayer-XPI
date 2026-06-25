# TokenLayer Web — Vite/React static build, served by nginx.
# Build context is the REPO ROOT (pnpm workspace), not apps/web.
FROM node:20-slim AS build

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app
COPY . .

# Install only the web app and its workspace deps (core).
RUN pnpm install --frozen-lockfile --filter "@tokenlayer/web..."

# The API origin is baked into the bundle at build time (Vite static replacement).
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @tokenlayer/web build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
