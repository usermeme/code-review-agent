# Stage 1: Build workspace and bundle code-reviewer agent
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

# Build code-reviewer agent
RUN pnpm nx build agent-code-reviewer --prod

# Stage 2: Production runtime with ADK API server
FROM node:24-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy built application and pruned package.json
COPY --chown=node:node --from=builder /app/dist/apps/agent-code-reviewer ./

# Install production dependencies and ADK runner
RUN npm install --omit=dev --ignore-scripts && npm install --no-save @google/adk-devtools@2.1.0 && chown -R node:node /app

# Run as non-root user
USER node

EXPOSE 8080

CMD ["sh", "-c", "npx adk api_server ./main.js --port=${PORT:-8080} --host=0.0.0.0"]
