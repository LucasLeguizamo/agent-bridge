# Self-host image: the bridge as one long-running Node process. Vercel does not use this file; its entry is src/index.ts.
# Node runs the TypeScript directly (type stripping), so there is no build step.
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
  && pnpm install --frozen-lockfile --prod

FROM node:26-slim
# Inside a container the bridge must listen on all interfaces; compose publishes it on 127.0.0.1 only.
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
# Served at /cli/bridge.mjs, so agents can install the CLI from their bridge.
COPY cli ./cli
USER node
EXPOSE 3000
# /health caches its answer for 30 s, so a probe every 30 s costs at most one query.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/standalone.ts"]
