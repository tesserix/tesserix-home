# Build stage
FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# Copy workspace manifests + lockfile first for cached, deterministic installs
COPY pnpm-workspace.yaml pnpm-lock.yaml .npmrc package.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/homechef-shared/package.json packages/homechef-shared/package.json
# apps/web imports @tesserix/platform-auth (session + CSRF) in ~60 files. Its
# package.json entries point at dist/, so it must be part of the workspace here
# AND built below, or `next build` fails with module-not-found.
COPY packages/platform-auth/package.json packages/platform-auth/package.json

# Install only what the web app needs (skips the React Native toolchain).
# @tesserix/* deps live on GitHub Packages which always requires auth. The
# token is mounted as a BuildKit secret so it never lands in an image layer;
# pnpm reads it via NODE_AUTH_TOKEN, already interpolated into .npmrc.
RUN --mount=type=secret,id=NODE_AUTH_TOKEN \
    NODE_AUTH_TOKEN="$(cat /run/secrets/NODE_AUTH_TOKEN)" \
    pnpm install --frozen-lockfile --filter web...

# Copy sources and build the web app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @tesserix/homechef-shared build \
    && pnpm --filter @tesserix/platform-auth build \
    && pnpm --filter web build

# Production stage
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Standalone bundle (contains apps/web/server.js + hoisted node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

CMD ["node", "apps/web/server.js"]
