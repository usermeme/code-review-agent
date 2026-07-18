FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json nx.json ./
COPY libs ./libs
COPY apps ./apps
RUN npx nx run-many -t build && npm prune --omit=dev

FROM node:22-slim
# git is required for shallow-cloning repos during context building
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

# We pass APP_NAME as an argument during build (gateway, agent-context-builder, agent-code-reviewer)
ARG APP_NAME
ENV APP_NAME=${APP_NAME}

USER node
EXPOSE 8080
CMD ["sh", "-c", "node dist/apps/${APP_NAME}/main.js"]
