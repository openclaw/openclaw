#!/usr/bin/env bash
set -euo pipefail

# Scan this repo for TODO/FIXME/XXX notes while avoiding common large/third-party dirs.
# Usage:
#   tools/todo_scan.sh                       # scan current repo
#   tools/todo_scan.sh "PATTERN"             # custom grep pattern
#   tools/todo_scan.sh --out tmp/todo.txt    # write to a file
#   tools/todo_scan.sh -q --out tmp/todo.txt # quiet (no stdout)
#
# Notes:
# - The scan is just grep; output is line-oriented and stable for copy/paste.

PATTERN='TODO|FIXME|XXX'
OUT_FILE=''
QUIET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--out)
      OUT_FILE="${2:-}"
      shift 2
      ;;
    -q|--quiet)
      QUIET=1
      shift
      ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *)
      PATTERN="$1"
      shift
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IGNORE_FILE="$ROOT_DIR/tools/ignore_paths.txt"

# Build repeated --exclude-dir args from ignore_paths.txt
EXCLUDE_ARGS=()
if [[ -f "$IGNORE_FILE" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#./}"
    line="${line%/}"
    EXCLUDE_ARGS+=( --exclude-dir="$line" )
  done < "$IGNORE_FILE"
fi

# Fallback if ignore file is missing/empty
if [[ ${#EXCLUDE_ARGS[@]} -eq 0 ]]; then
  EXCLUDE_ARGS=(
    --exclude-dir=.git
    --exclude-dir=node_modules
    --exclude-dir=projects
    --exclude-dir=generated
    --exclude-dir=tmp
    --exclude-dir=logs
    --exclude-dir=canvas
    --exclude-dir=voice_local
    --exclude-dir=voice_local_cuda
    --exclude-dir=comfyui
    --exclude-dir=contacts
    --exclude-dir=documents
    --exclude-dir=edumundo
    --exclude-dir=.venv
    --exclude-dir=.venv_*
    --exclude-dir=.venv_docx
    --exclude-dir=.venv_xls
  )
fi

# grep -RIn:
# -R recurse
# -I skip binary
# -n line numbers
# -E extended regex
# -H show filename

RESULT=$(grep -RInEH "${EXCLUDE_ARGS[@]}" \
  --exclude={package-lock.json,*.lock,*.min.js,*.map} \
  "$PATTERN" \
  . \
  | sed -E 's#^\./##' || true)

if [[ -n "$OUT_FILE" ]]; then
  mkdir -p "$(dirname "$OUT_FILE")"
  printf '%s\n' "$RESULT" > "$OUT_FILE"
fi

if [[ $QUIET -eq 0 ]]; then
  printf '%s\n' "$RESULT"
fi
