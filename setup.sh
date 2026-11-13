#!/bin/sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
fi

if grep -q "^HOST_DATA_PATH=" "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^HOST_DATA_PATH=.*|HOST_DATA_PATH=$DIR/data|" "$ENV_FILE"
else
  echo "HOST_DATA_PATH=$DIR/data" >> "$ENV_FILE"
fi

# Fuseau horaire de l'hôte pour les tâches planifiées (si non défini dans .env)
if ! grep -q "^TZ=." "$ENV_FILE" 2>/dev/null; then
  HOST_TZ="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || true)"
  if [ -n "$HOST_TZ" ]; then
    sed -i '/^TZ=/d' "$ENV_FILE"
    echo "TZ=$HOST_TZ" >> "$ENV_FILE"
  fi
fi

mkdir -p "$DIR/data/servers"

echo "HOST_DATA_PATH=$DIR/data"
echo ""
echo "Lancement de Craftarr..."
docker compose up -d --build
