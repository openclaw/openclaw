#!/bin/sh
# Vault sidecar entrypoint: decrypt secrets, render nginx config, start proxy.
#
# Expects:
#   AGE_SECRET_KEY          - age private key (from .env on host, 0600 root-owned)
#   /etc/vault.age          - age-encrypted secrets file (bind-mounted, read-only)
#   /etc/nginx/nginx.conf.template - nginx config template with ${VAR} placeholders
#   /run/secrets/           - tmpfs mount (volatile, never persisted to disk)
set -eu

VAULT_AGE="/etc/vault.age"
TEMPLATE="/etc/nginx/nginx.conf.template"
SECRETS_DIR="/run/secrets"

# Validate required inputs
if [ -z "${AGE_SECRET_KEY:-}" ]; then
  echo "ERROR: AGE_SECRET_KEY not set" >&2
  exit 1
fi

if [ ! -f "$VAULT_AGE" ]; then
  echo "ERROR: $VAULT_AGE not found" >&2
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: $TEMPLATE not found" >&2
  exit 1
fi

# Decrypt secrets to temporary env file on tmpfs
echo "$AGE_SECRET_KEY" | age -d -i - "$VAULT_AGE" > "$SECRETS_DIR/env"
unset AGE_SECRET_KEY

# Parse secrets line-by-line and export as environment variables.
# Uses IFS-based read instead of shell sourcing to prevent command injection
# via crafted secret values (e.g. values containing $(...) or backticks).
while IFS='=' read -r key value; do
  # Skip blank lines and comments
  case "$key" in
    ''|'#'*) continue ;;
  esac
  # Validate secret name: must be [A-Z][A-Z0-9_]* to prevent env hijacking
  # (e.g. PATH, LD_PRELOAD). Mirrors VALID_SECRET_NAME in vault-cli.ts.
  case "$key" in
    [A-Z]*) ;; # starts with uppercase — check rest below
    *) echo "WARNING: skipping invalid secret name: $key" >&2; continue ;;
  esac
  # shellcheck disable=SC2254
  case "$key" in
    *[!A-Z0-9_]*) echo "WARNING: skipping invalid secret name: $key" >&2; continue ;;
  esac
  export "$key=$value"
done < "$SECRETS_DIR/env"

# Validate expected secrets are present (empty = silent 401 errors downstream).
# Adding a new provider requires updating three files in sync:
#   1. vault/nginx.conf.template: add a server block with port and auth header
#   2. This file: add the secret name below AND to the envsubst call
#   3. src/vault/operations.ts: add the entry to VAULT_PROVIDER_DEFAULTS
MISSING=""
for var in OPENAI_API_KEY ANTHROPIC_API_KEY DEEPGRAM_API_KEY OPENAI_COMPAT_API_KEY GEMINI_API_KEY GROQ_API_KEY XAI_API_KEY MISTRAL_API_KEY BRAVE_API_KEY PERPLEXITY_API_KEY; do
  if [ -z "$(printenv "$var" 2>/dev/null)" ]; then
    MISSING="$MISSING $var"
  fi
done
if [ -n "$MISSING" ]; then
  echo "WARNING: Empty or missing secrets in vault.age:$MISSING" >&2
  echo "WARNING: Proxy requests for these providers will fail with 401 errors." >&2
fi

# Render nginx config with secrets injected.
# Explicit variable list prevents envsubst from replacing nginx variables
# like $http_upgrade, $host, etc.
envsubst '${OPENAI_API_KEY} ${ANTHROPIC_API_KEY} ${DEEPGRAM_API_KEY} ${OPENAI_COMPAT_API_KEY} ${GEMINI_API_KEY} ${GROQ_API_KEY} ${XAI_API_KEY} ${MISTRAL_API_KEY} ${BRAVE_API_KEY} ${PERPLEXITY_API_KEY}' \
  < "$TEMPLATE" \
  > "$SECRETS_DIR/nginx.conf"

# Wipe plaintext secrets (now embedded in rendered nginx.conf on tmpfs)
rm -f "$SECRETS_DIR/env"
unset OPENAI_API_KEY ANTHROPIC_API_KEY DEEPGRAM_API_KEY OPENAI_COMPAT_API_KEY GEMINI_API_KEY GROQ_API_KEY XAI_API_KEY MISTRAL_API_KEY BRAVE_API_KEY PERPLEXITY_API_KEY

# Lock down rendered config (contains plaintext secrets).
chmod 0400 "$SECRETS_DIR/nginx.conf"

echo "SUCCESS: Secrets decrypted, starting nginx reverse proxy"
# Master process runs as root to open log fds (/dev/stderr, /dev/stdout)
# and bind ports, then drops to 'user nginx' for worker processes via
# the nginx.conf 'user' directive. This is nginx's standard privilege model.
exec nginx -c "$SECRETS_DIR/nginx.conf" -g 'daemon off;'
