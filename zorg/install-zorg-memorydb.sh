#!/usr/bin/env bash
set -euo pipefail

# Zorg MemoryDB + LAN command chat bootstrap for OpenClaw installs.
# This is a GitHub package script. It installs prerequisites, copies packaged
# public-safe components into the OpenClaw workspace, initializes DB schema,
# imports packaged markdown rules, imports retired memory/*.md files into DB,
# and prepares LAN command chat. It ships no private memory rows or credentials.

ZORG_DB_NAME="${ZORG_DB_NAME:-zorgdb}"
ZORG_DB_USER="${ZORG_DB_USER:-zorg}"
ZORG_DB_HOST="${ZORG_DB_HOST:-127.0.0.1}"
ZORG_DB_PORT="${ZORG_DB_PORT:-5432}"
ZORG_DB_PASSWORD="${ZORG_DB_PASSWORD:-}"
LAN_CHAT_PORT="${LAN_CHAT_PORT:-3001}"
LAN_CHAT_HOST="${LAN_CHAT_HOST:-0.0.0.0}"

OPENCLAW_EFFECTIVE_HOME="${OPENCLAW_HOME:-$HOME}"
if [[ "$OPENCLAW_EFFECTIVE_HOME" == "~" ]]; then
  OPENCLAW_EFFECTIVE_HOME="$HOME"
elif [[ "$OPENCLAW_EFFECTIVE_HOME" == ~/* ]]; then
  OPENCLAW_EFFECTIVE_HOME="$HOME/${OPENCLAW_EFFECTIVE_HOME#~/}"
fi

OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$OPENCLAW_EFFECTIVE_HOME/.openclaw/workspace}"
ZORG_WORKSPACE_DIR="${ZORG_WORKSPACE_DIR:-$OPENCLAW_WORKSPACE/zorg-memorydb}"
LAN_CHAT_DIR="${LAN_CHAT_DIR:-$OPENCLAW_WORKSPACE/lan-chat}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

log() { printf '%s\n' "zorg-memorydb: $*"; }
warn() { printf '%s\n' "zorg-memorydb warning: $*" >&2; }
is_root() { [[ "$(id -u)" -eq 0 ]]; }
has_passwordless_sudo() { command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; }
sudo_if_needed() {
  if is_root; then
    "$@"
  elif has_passwordless_sudo; then
    sudo -n "$@"
  else
    return 127
  fi
}

install_packages() {
  local packages=("$@")
  [[ "${#packages[@]}" -gt 0 ]] || return 0
  if ! is_root && ! has_passwordless_sudo && ! command -v brew >/dev/null 2>&1; then
    warn "Missing prerequisites require root or passwordless sudo: ${packages[*]}"
    warn "Continuing with packaged Zorg files only. Install those packages as root, then rerun: $0"
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    sudo_if_needed env DEBIAN_FRONTEND=noninteractive apt-get update -qq || {
      warn "apt-get update failed; continuing with packaged Zorg files only."
      return 0
    }
    sudo_if_needed env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${packages[@]}" || {
      warn "apt-get install failed; continuing with packaged Zorg files only."
      return 0
    }
  elif command -v dnf >/dev/null 2>&1; then
    sudo_if_needed dnf install -y -q "${packages[@]}" || warn "dnf install failed; continuing with packaged Zorg files only."
  elif command -v yum >/dev/null 2>&1; then
    sudo_if_needed yum install -y -q "${packages[@]}" || warn "yum install failed; continuing with packaged Zorg files only."
  elif command -v pacman >/dev/null 2>&1; then
    sudo_if_needed pacman -Sy --noconfirm "${packages[@]}" || warn "pacman install failed; continuing with packaged Zorg files only."
  elif command -v apk >/dev/null 2>&1; then
    sudo_if_needed apk add --no-cache "${packages[@]}" || warn "apk add failed; continuing with packaged Zorg files only."
  elif command -v brew >/dev/null 2>&1; then
    brew install "${packages[@]}" || warn "brew install failed; continuing with packaged Zorg files only."
  else
    warn "No supported package manager found; install missing prerequisites manually."
  fi
}

ensure_prerequisites() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  command -v psql >/dev/null 2>&1 || missing+=(postgresql-client)
  command -v pg_isready >/dev/null 2>&1 || missing+=(postgresql)
  command -v npm >/dev/null 2>&1 || missing+=(npm)
  command -v node >/dev/null 2>&1 || missing+=(nodejs)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  if [[ "${#missing[@]}" -gt 0 ]]; then
    log "Installing missing prerequisites: ${missing[*]}"
    install_packages "${missing[@]}"
  fi
}

ensure_workspace_layout() {
  mkdir -p "$OPENCLAW_WORKSPACE" "$ZORG_WORKSPACE_DIR" "$LAN_CHAT_DIR"
  mkdir -p "$ZORG_WORKSPACE_DIR/db" "$ZORG_WORKSPACE_DIR/rules" "$ZORG_WORKSPACE_DIR/memory"
}

copy_packaged_components() {
  log "Copying packaged Zorg MemoryDB components into $ZORG_WORKSPACE_DIR"
  cp -R "$PACKAGE_ROOT/db/." "$ZORG_WORKSPACE_DIR/db/"
  cp -R "$PACKAGE_ROOT/rules/." "$ZORG_WORKSPACE_DIR/rules/"
  cp -R "$PACKAGE_ROOT/memory/." "$ZORG_WORKSPACE_DIR/memory/"
  log "Copying LAN command chat source into $LAN_CHAT_DIR"
  cp -R "$PACKAGE_ROOT/lan-command-chat/." "$LAN_CHAT_DIR/"
}

ensure_db_password() {
  if [[ -z "$ZORG_DB_PASSWORD" && -f "$OPENCLAW_WORKSPACE/sql_memory_map.json" ]]; then
    ZORG_DB_PASSWORD="$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1]))["postgres"]; print(p.get("password",""))' "$OPENCLAW_WORKSPACE/sql_memory_map.json" 2>/dev/null || true)"
  fi
  if [[ -z "$ZORG_DB_PASSWORD" ]]; then
    ZORG_DB_PASSWORD="$(openssl rand -hex 24 2>/dev/null || date +%s%N)"
  fi
}

ensure_postgres_database() {
  ensure_db_password
  if ! command -v psql >/dev/null 2>&1; then
    warn "psql is unavailable; database schema was copied but not applied."
    return 0
  fi
  if command -v pg_isready >/dev/null 2>&1 && ! pg_isready -h "$ZORG_DB_HOST" -p "$ZORG_DB_PORT" >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      sudo_if_needed systemctl enable --now postgresql >/dev/null 2>&1 || true
    fi
  fi
  PGPASSWORD="$ZORG_DB_PASSWORD" psql -h "$ZORG_DB_HOST" -p "$ZORG_DB_PORT" -U "$ZORG_DB_USER" -d "$ZORG_DB_NAME" -v ON_ERROR_STOP=1 -f "$ZORG_WORKSPACE_DIR/db/schema.sql" || {
    warn "Schema apply failed. Create database/role or set ZORG_DB_* variables, then rerun this script."
    return 0
  }
  PGPASSWORD="$ZORG_DB_PASSWORD" psql -h "$ZORG_DB_HOST" -p "$ZORG_DB_PORT" -U "$ZORG_DB_USER" -d "$ZORG_DB_NAME" -v ON_ERROR_STOP=1 -f "$ZORG_WORKSPACE_DIR/db/seed_rules.sql" || true
}

write_memory_config() {
  cat > "$OPENCLAW_WORKSPACE/sql_memory_map.json" <<JSON
{
  "postgres": {
    "host": "$ZORG_DB_HOST",
    "port": $ZORG_DB_PORT,
    "database": "$ZORG_DB_NAME",
    "user": "$ZORG_DB_USER",
    "password": "$ZORG_DB_PASSWORD"
  },
  "table_map": {
    "memory": "zorg_memory",
    "rules": "zorg_logic_rules",
    "markdown_imports": "zorg_markdown_imports",
    "lan_chat": "lan_chat_messages",
    "associations": "memory_associations",
    "entities": "memory_entities",
    "source_chunks": "memory_source_chunks",
    "query_observations": "query_observations"
  }
}
JSON
  cp "$ZORG_WORKSPACE_DIR/memory/memory_sql_tool.py" "$OPENCLAW_WORKSPACE/memory_sql_tool.py"
  cp "$ZORG_WORKSPACE_DIR/memory/memory_recall_router.py" "$OPENCLAW_WORKSPACE/memory_recall_router.py"
  chmod +x "$OPENCLAW_WORKSPACE/memory_sql_tool.py" "$OPENCLAW_WORKSPACE/memory_recall_router.py"
}

import_markdown_rules() {
  if [[ ! -x "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" ]]; then
    python3 -m venv "$OPENCLAW_WORKSPACE/.venv-sqlmem" || true
  fi
  if [[ -x "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" ]]; then
    "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" -m pip install --upgrade pip >/dev/null 2>&1 || true
    "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" -m pip install psycopg2-binary >/dev/null 2>&1 || true
    PGPASSWORD="$ZORG_DB_PASSWORD" "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" "$ZORG_WORKSPACE_DIR/db/import_markdown_rules.py" \
      --workspace "$OPENCLAW_WORKSPACE" \
      --rules-dir "$ZORG_WORKSPACE_DIR/rules" \
      --database-url "postgresql://$ZORG_DB_USER:$ZORG_DB_PASSWORD@$ZORG_DB_HOST:$ZORG_DB_PORT/$ZORG_DB_NAME" || true
  fi
}

prepare_lan_chat() {
  if [[ ! -f "$LAN_CHAT_DIR/.env.local" && -f "$LAN_CHAT_DIR/.env.local.example" ]]; then
    cp "$LAN_CHAT_DIR/.env.local.example" "$LAN_CHAT_DIR/.env.local"
    {
      printf '\nDATABASE_URL=postgresql://%s:%s@%s:%s/%s\n' "$ZORG_DB_USER" "$ZORG_DB_PASSWORD" "$ZORG_DB_HOST" "$ZORG_DB_PORT" "$ZORG_DB_NAME"
      printf 'LAN_CHAT_PORT=%s\n' "$LAN_CHAT_PORT"
      printf 'PORT=%s\n' "$LAN_CHAT_PORT"
    } >> "$LAN_CHAT_DIR/.env.local"
  fi
  if command -v npm >/dev/null 2>&1 && [[ -f "$LAN_CHAT_DIR/package.json" ]]; then
    (cd "$LAN_CHAT_DIR" && npm install)
    (cd "$LAN_CHAT_DIR" && npm run build) || warn "LAN chat build failed; inspect $LAN_CHAT_DIR and rerun npm run build."
  fi
}

install_lan_chat_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd is unavailable; LAN chat source is installed but no service was created."
    return 0
  fi
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/lan-chat.service" <<SERVICE
[Unit]
Description=Zorg LAN command chat
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$LAN_CHAT_DIR
Environment=PORT=$LAN_CHAT_PORT
Environment=HOSTNAME=$LAN_CHAT_HOST
ExecStart=/usr/bin/env npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE
  systemctl --user daemon-reload || true
  systemctl --user enable lan-chat.service || true
  systemctl --user restart lan-chat.service || warn "LAN chat service restart failed; run: systemctl --user status lan-chat.service"
}

main() {
  while [[ "${1:-}" == --* ]]; do
    case "$1" in
      --from-openclaw-install) shift ;;
      *) warn "Ignoring unknown option: $1"; shift ;;
    esac
  done
  ensure_prerequisites
  ensure_workspace_layout
  copy_packaged_components
  ensure_postgres_database
  write_memory_config
  import_markdown_rules
  prepare_lan_chat
  install_lan_chat_service
  log "Zorg MemoryDB and LAN command chat bootstrap complete."
}
main "$@"
