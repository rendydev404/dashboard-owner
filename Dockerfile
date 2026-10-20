# syntax=docker/dockerfile:1
# Satu image: API (Hono) + web statis (Vite) + worker sinkron. Dipakai Coolify (build pack: Dockerfile).
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@iklan/api..." --filter "@iklan/web..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @iklan/web build && pnpm --filter @iklan/api build

# Dependensi runtime saja (native @node-rs/argon2 untuk musl ikut terpasang di sini).
FROM node:22-alpine AS deps
WORKDIR /app
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund @node-rs/argon2@2

FROM node:22-alpine
ENV NODE_ENV=production TZ=Asia/Jakarta PORT=3000 STATIC_DIR=public MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/web/dist ./public
COPY db/migrations ./migrations
RUN echo '{"type":"module"}' > package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--max-old-space-size=256", "dist/index.js"]
