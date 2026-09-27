# ─── Dépendances (outils de compilation seulement ici) ───────
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci : installe exactement le lockfile (builds reproductibles)
RUN npm ci --omit=dev --no-audit --no-fund

# ─── Image finale ────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /data/servers

EXPOSE 3000

CMD ["node", "src/index.js"]
