#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log() {
  printf '\n[%s] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$*"
}

if [[ ! -f "Dockerfile.local" ]]; then
  echo "ERROR: Dockerfile.local not found in $SCRIPT_DIR"
  echo "Move this script into your OpenClaw install folder, then run it there."
  exit 1
fi

log "Tagging current local image as openclaw:backup"
docker tag openclaw:local openclaw:backup

log "Pulling latest upstream OpenClaw image"
docker pull ghcr.io/openclaw/openclaw:latest

log "Building updated local image from Dockerfile.local"
docker build -f Dockerfile.local -t openclaw:local .

log "Recreating openclaw-gateway"
docker compose up -d --force-recreate openclaw-gateway

log "Waiting 4 seconds before doctor --fix"
sleep 4

log "Running doctor --fix"
docker compose run --rm openclaw-gateway openclaw doctor --fix

log "Done"
log "Gateway version"
docker compose exec -T openclaw-gateway sh -lc 'openclaw --version'
