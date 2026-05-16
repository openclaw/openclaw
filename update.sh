#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BACKUP_SCRIPT="${BACKUP_SCRIPT_OVERRIDE:-$SCRIPT_DIR/backup.sh}"
DOCKER_BIN="${DOCKER_BIN_OVERRIDE:-docker}"
SKIP_PRE_UPDATE_BACKUP="${SKIP_PRE_UPDATE_BACKUP:-}"
UPDATE_DOCTOR_DELAY_SECONDS="${UPDATE_DOCTOR_DELAY_SECONDS:-4}"
UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV="OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE"

log() {
  printf '\n[%s] %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S UTC')" "$*"
}

if [[ ! -f "Dockerfile.local" ]]; then
  echo "ERROR: Dockerfile.local not found in $SCRIPT_DIR"
  echo "Move this script into your OpenClaw install folder, then run it there."
  exit 1
fi

if [[ -n "$SKIP_PRE_UPDATE_BACKUP" ]]; then
  log "Skipping pre-update backup (SKIP_PRE_UPDATE_BACKUP set)"
else
  if [[ ! -f "$BACKUP_SCRIPT" ]]; then
    echo "ERROR: backup script not found at $BACKUP_SCRIPT"
    echo "Set BACKUP_SCRIPT_OVERRIDE or SKIP_PRE_UPDATE_BACKUP=1 if you intentionally want to update without a snapshot."
    exit 1
  fi

  log "Running pre-update backup"
  bash "$BACKUP_SCRIPT"
fi

log "Tagging current local image as openclaw:backup"
"$DOCKER_BIN" tag openclaw:local openclaw:backup

log "Pulling latest upstream OpenClaw image"
"$DOCKER_BIN" pull ghcr.io/openclaw/openclaw:latest

log "Building updated local image from Dockerfile.local"
"$DOCKER_BIN" build -f Dockerfile.local -t openclaw:local .

log "Recreating openclaw-gateway"
"$DOCKER_BIN" compose up -d --force-recreate openclaw-gateway

log "Waiting $UPDATE_DOCTOR_DELAY_SECONDS seconds before doctor --fix"
sleep "$UPDATE_DOCTOR_DELAY_SECONDS"

log "Running doctor --fix"
"$DOCKER_BIN" compose run --rm \
  -e OPENCLAW_UPDATE_IN_PROGRESS=1 \
  -e "${UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV}=1" \
  openclaw-gateway \
  openclaw doctor --fix --non-interactive

log "Restarting openclaw-gateway to load doctor repairs"
"$DOCKER_BIN" compose restart openclaw-gateway

log "Waiting $UPDATE_DOCTOR_DELAY_SECONDS seconds after doctor repair restart"
sleep "$UPDATE_DOCTOR_DELAY_SECONDS"

log "Pruning old Docker build cache and dangling images"
"$DOCKER_BIN" system prune -f

log "Done"
log "Gateway version"
"$DOCKER_BIN" compose exec -T openclaw-gateway sh -lc 'openclaw --version'
