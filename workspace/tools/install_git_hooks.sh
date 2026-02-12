#!/usr/bin/env bash
set -euo pipefail

# Install lightweight git hooks for this repo.
# Currently installs a pre-commit hook that blocks commits if secrets_scan finds obvious tokens.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_DIR="$REPO_ROOT/.git/hooks"
HOOK_PATH="$HOOK_DIR/pre-commit"

mkdir -p "$HOOK_DIR"

cat > "$HOOK_PATH" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Block commits if obvious secrets are detected.
# Override (not recommended): git commit --no-verify

ROOT="$(git rev-parse --show-toplevel)"
python3 "$ROOT/tools/secrets_scan.py" --root "$ROOT" --max 200 >/dev/null
EOF

chmod +x "$HOOK_PATH"

echo "Installed: $HOOK_PATH"
echo "Hook: runs tools/secrets_scan.py before each commit (use --no-verify to bypass)."
