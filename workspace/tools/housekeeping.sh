#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITIGNORE="$ROOT_DIR/.gitignore"

APPLY=0
TOP_N=15
REPORT_MD=0
OUT_PATH=""

usage() {
  cat <<'EOF'
Usage: tools/housekeeping.sh [--dry-run] [--apply-gitignore] [--top N] [--report-md] [--out PATH]

Non-destructive workspace hygiene helper.

What it does:
  1) Shows git status summary (untracked/modified counts)
  2) Prints largest directories/files under the repo (helps spot noise)
  3) Suggests .gitignore entries for common generated/big folders if detected

By default it's dry-run (prints suggestions only).

Options:
  --dry-run           Explicitly dry-run (default)
  --apply-gitignore   Append suggested patterns into .gitignore (idempotent-ish)
  --top N             How many largest dirs/files to show (default: 15)
  --report-md         Print output in Markdown-ish format (good for pasting into memory)
  --out PATH          Also write the full report to PATH (overwrites)
  -h, --help          Show this help
EOF
}

log() { printf '%s\n' "$*"; }
md_h1() { [[ $REPORT_MD -eq 1 ]] && printf '\n## %s\n' "$*" || log "== $* =="; }
md_blank() { printf '\n'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) APPLY=0; shift;;
    --apply-gitignore) APPLY=1; shift;;
    --top) TOP_N="${2:-}"; shift 2;;
    --report-md) REPORT_MD=1; shift;;
    --out) OUT_PATH="${2:-}"; shift 2;;
    -h|--help) usage; exit 0;;
    *) log "Unknown arg: $1"; usage; exit 2;;
  esac
done

cd "$ROOT_DIR"

if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname -- "$OUT_PATH")"
  # tee keeps stdout visible while saving a copy
  exec > >(tee "$OUT_PATH")
fi

md_h1 "Git status (summary)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # porcelain v1 is stable for parsing
  PORCELAIN="$(git status --porcelain=v1 || true)"
  MODIFIED=$(printf '%s\n' "$PORCELAIN" | grep -E '^( M|MM|AM|A | D|D )' -c || true)
  UNTRACKED=$(printf '%s\n' "$PORCELAIN" | grep -E '^\?\?' -c || true)
  log "Modified/staged entries: $MODIFIED"
  log "Untracked entries:      $UNTRACKED"
else
  log "(not a git repo)"
fi

md_blank
md_h1 "Largest directories (top $TOP_N)"
# Exclude obvious heavy/noisy dirs by default
# Use du -x to stay on same filesystem; suppress permission noise
(du -x -d 2 -h . 2>/dev/null | sort -hr | head -n "$TOP_N") || true

md_blank
md_h1 "Largest files (top $TOP_N)"
IGNORE_FILE="$ROOT_DIR/tools/ignore_paths.txt"
FIND_EXCLUDES=()
if [[ -f "$IGNORE_FILE" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#./}"
    line="${line%/}"
    # Expand globs like .venv_* safely as patterns in -path
    FIND_EXCLUDES+=( -not -path "./$line" -not -path "./$line/*" )
  done < "$IGNORE_FILE"
fi

# If ignore file missing, keep a minimal safe default
if [[ ${#FIND_EXCLUDES[@]} -eq 0 ]]; then
  FIND_EXCLUDES=(
    -not -path './.git' -not -path './.git/*'
    -not -path './node_modules' -not -path './node_modules/*'
    -not -path './.venv' -not -path './.venv/*'
    -not -path './.venv_*' -not -path './.venv_*/*'
  )
fi

(find . -type f \
  "${FIND_EXCLUDES[@]}" \
  -printf '%s\t%p\n' 2>/dev/null \
  | sort -nr \
  | head -n "$TOP_N" \
  | awk -F'	' '{printf "%.2f MiB\t%s\n", $1/1024/1024, $2}') || true

md_blank
md_h1 ".gitignore suggestions"
# Common generated/cache dirs in this workspace
SUGGESTIONS=(
  'node_modules/'
  '.venv/'
  '.venv_*/'
  '__pycache__/'
  '*.pyc'
  'tmp/'
  'generated/'
  'logs/'
  'voice_local/'
  'voice_local_cuda/'
  '/tools/secrets.local.md'
)

# Also suggest ignoring nested git repos (common when you keep multiple standalone projects
# under this workspace). This reduces noise if you later git-init the workspace root.
if [[ -d "$ROOT_DIR/projects" ]]; then
  while IFS= read -r gitdir; do
    repo_dir="${gitdir%/.git}"
    rel="${repo_dir#"$ROOT_DIR"/}"
    [[ -n "$rel" ]] && SUGGESTIONS+=("$rel/")
  done < <(find "$ROOT_DIR/projects" -mindepth 2 -maxdepth 5 -type d -name .git 2>/dev/null || true)
fi

if [[ ! -f "$GITIGNORE" ]]; then
  log "No .gitignore found at: $GITIGNORE"
  if [[ $APPLY -eq 1 ]]; then
    log "Creating .gitignore..."
    touch "$GITIGNORE"
  else
    log "(dry-run) would create .gitignore"
  fi
fi

added_any=0
for pat in "${SUGGESTIONS[@]}"; do
  # Only suggest if something matching exists OR it is a known secret path
  exists=0
  if [[ "$pat" == '/tools/secrets.local.md' || "$pat" == 'tools/secrets.local.md' ]]; then
    exists=1
  else
    # glob check
    shopt -s nullglob
    matches=( $pat )
    shopt -u nullglob
    if [[ ${#matches[@]} -gt 0 ]]; then exists=1; fi
  fi

  if [[ $exists -eq 0 ]]; then
    continue
  fi

  if [[ -f "$GITIGNORE" ]] && grep -Fxq "$pat" "$GITIGNORE"; then
    continue
  fi

  log "- $pat"

  if [[ $APPLY -eq 1 ]]; then
    printf '%s\n' "$pat" >> "$GITIGNORE"
    added_any=1
  fi
done

if [[ $APPLY -eq 1 ]]; then
  if [[ $added_any -eq 1 ]]; then
    log ""
    log "Applied: appended suggestions to .gitignore"
  else
    log "(nothing to apply)"
  fi
else
  log ""
  log "(dry-run) no files changed. Use --apply-gitignore to append patterns."
fi
