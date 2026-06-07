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
OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH="${OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH:-true}"
ZORG_INSTALL_MODE="${ZORG_INSTALL_MODE:-first-run}"
ZORG_PATCH_EXISTING_DOCKER_CONFIG="${ZORG_PATCH_EXISTING_DOCKER_CONFIG:-0}"

default_openclaw_home() {
  if [[ -n "${OPENCLAW_HOME:-}" ]]; then
    printf '%s\n' "$OPENCLAW_HOME"
    return 0
  fi
  if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER:-}" != "root" ]]; then
    local sudo_home
    sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | awk -F: '{print $6}')"
    if [[ -n "$sudo_home" && -d "$sudo_home" ]]; then
      printf '%s\n' "$sudo_home"
      return 0
    fi
  fi
  printf '%s\n' "$HOME"
}

OPENCLAW_EFFECTIVE_HOME="$(default_openclaw_home)"
if [[ "$OPENCLAW_EFFECTIVE_HOME" == "~" ]]; then
  OPENCLAW_EFFECTIVE_HOME="$HOME"
elif [[ "$OPENCLAW_EFFECTIVE_HOME" == ~/* ]]; then
  OPENCLAW_EFFECTIVE_HOME="$HOME/${OPENCLAW_EFFECTIVE_HOME#~/}"
fi

OPENCLAW_WORKSPACE="${OPENCLAW_WORKSPACE:-$OPENCLAW_EFFECTIVE_HOME/.openclaw/workspace}"
ZORG_WORKSPACE_DIR="${ZORG_WORKSPACE_DIR:-$OPENCLAW_WORKSPACE/zorg-memorydb}"
LAN_CHAT_DIR="${LAN_CHAT_DIR:-$OPENCLAW_WORKSPACE/lan-chat}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PACKAGE_ROOT="$SCRIPT_DIR"

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

maybe_chown_sudo_workspace() {
  if [[ "$(id -u)" -ne 0 || -z "${SUDO_USER:-}" || "${SUDO_USER:-}" == "root" ]]; then
    return 0
  fi
  local sudo_home
  sudo_home="$(getent passwd "$SUDO_USER" 2>/dev/null | awk -F: '{print $6}')"
  if [[ -n "$sudo_home" && "$OPENCLAW_WORKSPACE" == "$sudo_home"/.openclaw/workspace* ]]; then
    chown -R "$SUDO_USER:$SUDO_USER" "$OPENCLAW_WORKSPACE" 2>/dev/null || true
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
  python3 -c "import ensurepip" >/dev/null 2>&1 || missing+=(python3-venv)
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
  if [[ -f "$PACKAGE_ROOT/requirements.txt" ]]; then
    cp "$PACKAGE_ROOT/requirements.txt" "$ZORG_WORKSPACE_DIR/requirements.txt"
  fi
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

is_safe_pg_identifier() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
}

sql_quote_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

run_postgres_superuser_sql() {
  local sql="$1"
  if is_root; then
    su - postgres -c "psql -v ON_ERROR_STOP=1 -Atqc \"$sql\""
  elif has_passwordless_sudo; then
    sudo -n -u postgres psql -v ON_ERROR_STOP=1 -Atqc "$sql"
  else
    return 127
  fi
}

start_local_postgres() {
  if command -v pg_isready >/dev/null 2>&1 && pg_isready -h "$ZORG_DB_HOST" -p "$ZORG_DB_PORT" >/dev/null 2>&1; then
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    sudo_if_needed systemctl enable --now postgresql >/dev/null 2>&1 || true
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    local cluster
    while read -r cluster; do
      [[ -n "$cluster" ]] || continue
      sudo_if_needed pg_ctlcluster $cluster start >/dev/null 2>&1 || true
    done < <(pg_lsclusters --no-header 2>/dev/null | awk '{print $1 " " $2}')
  fi
}

ensure_local_postgres_role_database() {
  case "$ZORG_DB_HOST" in
    127.0.0.1|localhost|::1) ;;
    *) return 0 ;;
  esac
  [[ "$ZORG_DB_PORT" == "5432" ]] || return 0
  is_safe_pg_identifier "$ZORG_DB_USER" || { warn "Skipping automatic PostgreSQL role creation because ZORG_DB_USER is not a simple identifier."; return 0; }
  is_safe_pg_identifier "$ZORG_DB_NAME" || { warn "Skipping automatic PostgreSQL database creation because ZORG_DB_NAME is not a simple identifier."; return 0; }

  local quoted_password
  quoted_password="$(sql_quote_literal "$ZORG_DB_PASSWORD")"

  if ! run_postgres_superuser_sql "SELECT 1" >/dev/null 2>&1; then
    warn "PostgreSQL superuser access is unavailable; create role/database manually or set ZORG_DB_* variables."
    return 0
  fi

  if [[ "$(run_postgres_superuser_sql "SELECT 1 FROM pg_roles WHERE rolname = '$ZORG_DB_USER'" 2>/dev/null || true)" != "1" ]]; then
    run_postgres_superuser_sql "CREATE ROLE \"$ZORG_DB_USER\" WITH LOGIN PASSWORD '$quoted_password'" >/dev/null || {
      warn "Could not create PostgreSQL role $ZORG_DB_USER."
      return 0
    }
  else
    run_postgres_superuser_sql "ALTER ROLE \"$ZORG_DB_USER\" WITH LOGIN PASSWORD '$quoted_password'" >/dev/null || true
  fi

  if [[ "$(run_postgres_superuser_sql "SELECT 1 FROM pg_database WHERE datname = '$ZORG_DB_NAME'" 2>/dev/null || true)" != "1" ]]; then
    run_postgres_superuser_sql "CREATE DATABASE \"$ZORG_DB_NAME\" OWNER \"$ZORG_DB_USER\"" >/dev/null || {
      warn "Could not create PostgreSQL database $ZORG_DB_NAME."
      return 0
    }
  fi
}

ensure_postgres_database() {
  ensure_db_password
  if ! command -v psql >/dev/null 2>&1; then
    warn "psql is unavailable; database schema was copied but not applied."
    return 0
  fi
  start_local_postgres
  ensure_local_postgres_role_database
  PGPASSWORD="$ZORG_DB_PASSWORD" psql -h "$ZORG_DB_HOST" -p "$ZORG_DB_PORT" -U "$ZORG_DB_USER" -d "$ZORG_DB_NAME" -v ON_ERROR_STOP=1 -f "$ZORG_WORKSPACE_DIR/db/schema.sql" || {
    warn "Schema apply failed. Create database/role or set ZORG_DB_* variables, then rerun this script."
    return 0
  }
  if [[ -f "$ZORG_WORKSPACE_DIR/db/memory_file_archive_schema.sql" ]]; then
    PGPASSWORD="$ZORG_DB_PASSWORD" psql -h "$ZORG_DB_HOST" -p "$ZORG_DB_PORT" -U "$ZORG_DB_USER" -d "$ZORG_DB_NAME" -v ON_ERROR_STOP=1 -f "$ZORG_WORKSPACE_DIR/db/memory_file_archive_schema.sql" || true
  fi
  if [[ -f "$ZORG_WORKSPACE_DIR/db/public_canonical_rules_update_2026_06_02.sql" ]]; then
    PGPASSWORD="$ZORG_DB_PASSWORD" psql -h "$ZORG_DB_HOST" -p "$ZORG_DB_PORT" -U "$ZORG_DB_USER" -d "$ZORG_DB_NAME" -v ON_ERROR_STOP=1 -f "$ZORG_WORKSPACE_DIR/db/public_canonical_rules_update_2026_06_02.sql" || true
  fi
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
  if [[ -f "$ZORG_WORKSPACE_DIR/memory/archive_retired_memory_dir.py" ]]; then
    cp "$ZORG_WORKSPACE_DIR/memory/archive_retired_memory_dir.py" "$OPENCLAW_WORKSPACE/archive_retired_memory_dir.py"
  fi
  if [[ -f "$ZORG_WORKSPACE_DIR/memory/enforce_db_memory_search.py" ]]; then
    cp "$ZORG_WORKSPACE_DIR/memory/enforce_db_memory_search.py" "$OPENCLAW_WORKSPACE/enforce_db_memory_search.py"
  fi
  chmod +x "$OPENCLAW_WORKSPACE/memory_sql_tool.py" "$OPENCLAW_WORKSPACE/memory_recall_router.py"
  [[ -f "$OPENCLAW_WORKSPACE/archive_retired_memory_dir.py" ]] && chmod +x "$OPENCLAW_WORKSPACE/archive_retired_memory_dir.py"
  [[ -f "$OPENCLAW_WORKSPACE/enforce_db_memory_search.py" ]] && chmod +x "$OPENCLAW_WORKSPACE/enforce_db_memory_search.py"
}

write_gateway_tui_compat_config() {
  python3 - "$OPENCLAW_EFFECTIVE_HOME" "$OPENCLAW_WORKSPACE" "$OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH" <<'PY'
from pathlib import Path
import json
import sys

home = Path(sys.argv[1]).expanduser()
workspace = Path(sys.argv[2]).expanduser()
disable_device_auth = sys.argv[3].strip().lower() in {"1", "true", "yes", "on"}

candidates = []
for candidate in (
    home / "openclaw.json",
    home / ".openclaw" / "openclaw.json",
    workspace.parent / "openclaw.json",
):
    if candidate not in candidates:
        candidates.append(candidate)

updated = False
for path in candidates:
    if not path.exists():
        continue
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        continue
    if not isinstance(config, dict):
        continue
    gateway = config.setdefault("gateway", {})
    if not isinstance(gateway, dict):
        continue
    control_ui = gateway.setdefault("controlUi", {})
    if not isinstance(control_ui, dict):
        gateway["controlUi"] = control_ui = {}

    control_ui["allowInsecureAuth"] = True
    if disable_device_auth:
        control_ui["dangerouslyDisableDeviceAuth"] = True

    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(f"zorg-memorydb: updated Docker/TUI gateway compatibility config: {path}")
    updated = True

if not updated:
    print("zorg-memorydb warning: no existing OpenClaw gateway config found for Docker/TUI compatibility patch", file=sys.stderr)
PY
  if [[ "$OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH" =~ ^([Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|1|[Oo][Nn])$ ]]; then
    warn "Enabled token-protected Docker/TUI compatibility by disabling Control UI device-auth checks. Set OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH=false for hardened HTTPS or paired-device deployments."
  fi
}

install_agent_readable_markdown() {
  log "Installing agent-readable Zorg MemoryDB markdown instructions"
  if [[ -f "$ZORG_WORKSPACE_DIR/rules/ZORG_MEMORYDB_MASTER_RULES.md" ]]; then
    cp "$ZORG_WORKSPACE_DIR/rules/ZORG_MEMORYDB_MASTER_RULES.md" "$OPENCLAW_WORKSPACE/ZORG_MEMORYDB_MASTER_RULES.md"
  fi
  if [[ -f "$ZORG_WORKSPACE_DIR/rules/RESURRECTION.md" ]]; then
    cp "$ZORG_WORKSPACE_DIR/rules/RESURRECTION.md" "$OPENCLAW_WORKSPACE/RESURRECTION.md"
  fi
  python3 - "$OPENCLAW_WORKSPACE" <<'PY'
from pathlib import Path
import sys

workspace = Path(sys.argv[1])
marker = "<!-- ZORG_MEMORYDB_AGENT_USAGE -->"
block = """<!-- ZORG_MEMORYDB_AGENT_USAGE -->
## Zorg MemoryDB Agent Memory Usage

Zorg MemoryDB is the active durable memory backend for this OpenClaw workspace. The agent must use the PostgreSQL-backed memory path for continuity, not MEMORY.md or memory/ markdown files as active memory.

### Required Agent Behavior

1. Before answering or acting, check backend database memory using the configured DB recall path.
2. If the first DB recall pass is weak or empty, run a deeper DB recall search with alternate terms before concluding there is no prior context.
3. Do not create, update, or rely on memory/YYYY-MM-DD.md, memory/projects/*.md, memory/*.json, or other flat-file memory as durable memory.
4. If legacy markdown memory files exist, import them into Zorg MemoryDB, then treat them as retired source files rather than active memory.
5. If DB recall is unavailable, repair or restore the DB path and fail closed instead of silently falling back to files.
6. Preserve original memory data. Improve recall with additive DB structures such as indexes, source chunks, entities, associations, observations, and rule rows.
7. Runtime hooks must not create retired memory markdown files. If a generated memory file appears anyway, import it into PostgreSQL immediately and remove the file after successful import.
8. User-visible operational replies must include the operator request timestamp, actual response timestamp, and elapsed duration computed from those two times.

### Local DB Memory Files

- DB config: sql_memory_map.json
- Recall CLI: memory_sql_tool.py
- Recall router: memory_recall_router.py
- Packaged rules: zorg-memorydb/rules/
- Filesystem resurrection restore path: RESURRECTION.md
- Master public install rule file: ZORG_MEMORYDB_MASTER_RULES.md

### Quick Verification Commands

    .venv-sqlmem/bin/python memory_sql_tool.py "Zorg MemoryDB" --limit 5
    .venv-sqlmem/bin/python memory_recall_router.py "How do I use Zorg MemoryDB for memory?"

Expected result: the commands return DB-backed rules or source chunks explaining Zorg MemoryDB usage. A clean install is incomplete if these markdown instructions are missing from agent-readable files.
<!-- /ZORG_MEMORYDB_AGENT_USAGE -->"""

targets = [
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
    "IDENTITY.md",
    "HEARTBEAT.md",
]
for name in targets:
    path = workspace / name
    existing = path.read_text(encoding="utf-8", errors="replace") if path.exists() else f"# {name}\n"
    if marker not in existing:
        path.write_text(block + "\n\n" + existing, encoding="utf-8")
PY
}

import_markdown_rules() {
  if [[ ! -x "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" ]]; then
    python3 -m venv "$OPENCLAW_WORKSPACE/.venv-sqlmem" || {
      warn "Could not create SQL memory virtualenv. Install python3-venv, then rerun this script."
      return 0
    }
  fi
  if [[ -x "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" ]]; then
    "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" -m pip install --upgrade pip >/dev/null 2>&1 || true
    if [[ -f "$ZORG_WORKSPACE_DIR/requirements.txt" ]]; then
      "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" -m pip install -r "$ZORG_WORKSPACE_DIR/requirements.txt" >/dev/null 2>&1 || true
    else
      "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" -m pip install psycopg2-binary >/dev/null 2>&1 || true
    fi
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
  local npm_bin
  npm_bin="$(command -v npm || true)"
  if [[ -z "$npm_bin" ]]; then
    warn "npm is unavailable; LAN chat source is installed but no service was created."
    return 0
  fi
  local service_path
  service_path="$(dirname "$npm_bin"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  if [[ "$(id -u)" == "0" ]]; then
    local service_user
    service_user="$(stat -c '%U' "$OPENCLAW_WORKSPACE" 2>/dev/null || true)"
    if [[ -z "$service_user" || "$service_user" == "UNKNOWN" || "$service_user" == "root" ]]; then
      service_user="${SUDO_USER:-root}"
    fi
    if [[ "$service_user" == "root" ]]; then
      warn "Running as root and no non-root OpenClaw workspace owner was found; LAN chat source is installed but no service was created."
      return 0
    fi
    cat > /etc/systemd/system/lan-chat.service <<SERVICE
[Unit]
Description=Zorg LAN command chat
After=network-online.target postgresql.service

[Service]
Type=simple
User=$service_user
WorkingDirectory=$LAN_CHAT_DIR
Environment=PATH=$service_path
Environment=PORT=$LAN_CHAT_PORT
Environment=HOSTNAME=$LAN_CHAT_HOST
ExecStart=$npm_bin run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE
    systemctl daemon-reload || true
    systemctl enable lan-chat.service || true
    systemctl restart lan-chat.service || warn "LAN chat service restart failed; run: systemctl status lan-chat.service"
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
Environment=PATH=$service_path
Environment=PORT=$LAN_CHAT_PORT
Environment=HOSTNAME=$LAN_CHAT_HOST
ExecStart=$npm_bin run start
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
      --install-mode)
        ZORG_INSTALL_MODE="${2:-first-run}"
        shift 2
        ;;
      --patch-existing-docker-config)
        ZORG_PATCH_EXISTING_DOCKER_CONFIG=1
        shift
        ;;
      *) warn "Ignoring unknown option: $1"; shift ;;
    esac
  done
  ensure_prerequisites
  ensure_workspace_layout
  copy_packaged_components
  ensure_postgres_database
  write_memory_config
  if [[ "$ZORG_PATCH_EXISTING_DOCKER_CONFIG" == "1" ]]; then
    write_gateway_tui_compat_config
  else
    log "Skipping existing Docker/TUI gateway config patch; set ZORG_PATCH_EXISTING_DOCKER_CONFIG=1 only for an intentional existing Docker repair."
  fi
  install_agent_readable_markdown
  import_markdown_rules
  if [[ -x "$OPENCLAW_WORKSPACE/enforce_db_memory_search.py" ]]; then
    "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" "$OPENCLAW_WORKSPACE/enforce_db_memory_search.py" || true
  fi
  if [[ -d "$OPENCLAW_WORKSPACE/memory" && -x "$OPENCLAW_WORKSPACE/archive_retired_memory_dir.py" ]]; then
    ZORG_SKIP_RECALL_REFRESH=1 "$OPENCLAW_WORKSPACE/.venv-sqlmem/bin/python" "$OPENCLAW_WORKSPACE/archive_retired_memory_dir.py" || true
  fi
  prepare_lan_chat
  maybe_chown_sudo_workspace
  install_lan_chat_service
  log "Zorg MemoryDB and LAN command chat bootstrap complete."
}
main "$@"
