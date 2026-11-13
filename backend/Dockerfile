# ─── Dépendances (outils de compilation seulement ici) ───────
FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci : installe exactement le lockfile (builds reproductibles)
RUN npm ci --omit=dev --no-audit --no-fund

# ─── Image finale ────────────────────────────────────────────
FROM node:24-alpine
# restic : sauvegardes hors site ; openssh-client : dépôts sftp:
RUN apk add --no-cache su-exec restic openssh-client
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY docker-entrypoint.sh ./

RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /data/servers /data/backups

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
