# Plumbline web: the product site, verify pages, badges and lead form (packages/web). Reads Solana over RPC.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npx", "tsx", "packages/web/src/server.ts"]
