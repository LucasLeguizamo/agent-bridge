# Runs TypeScript directly with Node's type stripping, so there is no build step.
FROM node:24.22.2-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
  && pnpm install --prod --frozen-lockfile

FROM node:24.22.2-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/main.ts"]
