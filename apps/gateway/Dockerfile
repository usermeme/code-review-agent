# Stage 1: Build workspace and bundle gateway
FROM node:24-slim AS builder

WORKDIR /app

# Enable Corepack and activate pnpm matching workspace version
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

# Copy dependency manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* .npmrc* ./

# Install dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Copy source code and Nx workspace configuration
COPY . .

# Build gateway application
RUN pnpm nx build gateway --prod

# Stage 2: Production runtime
FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Enable Corepack and activate pnpm matching workspace version
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

# Copy built application and pruned package.json
COPY --chown=node:node --from=builder /app/dist/apps/gateway ./

# Install production dependencies using frozen lockfile
RUN pnpm install --prod --frozen-lockfile && chown -R node:node /app

# Run as non-root user
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
