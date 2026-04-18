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

mkdir -p "$DIR/data/servers"

echo "HOST_DATA_PATH=$DIR/data"
echo ""
echo "Lancement de Craftarr..."
docker compose up -d --build
