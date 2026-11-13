#!/bin/sh
# Démarre le backend sous l'utilisateur « node » (uid 1000, le même que les serveurs itzg).
# Lancé en root uniquement pour remettre les droits de /data en ordre, puis abandonne root.
set -e

MARKER=/data/.craftarr-owner-1000

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/servers /data/backups
  if [ ! -e "$MARKER" ]; then
    # Une seule fois : les anciennes versions tournaient en root et ont écrit modpacks,
    # sauvegardes et base en root. Les mondes déjà en uid 1000 (itzg) ne changent pas.
    echo "[entrypoint] Passage de /data à l'uid 1000 (une seule fois, peut prendre un moment)…"
    chown -R 1000:1000 /data
    touch "$MARKER"
    chown 1000:1000 "$MARKER"
  else
    # Dossiers de premier niveau recréés entre-temps
    chown 1000:1000 /data /data/servers /data/backups
  fi
  exec su-exec node "$@"
fi

exec "$@"
