#!/usr/bin/env bash
set -euo pipefail

# Bulk wrapper for tools/todo_tracker.py
# Safe by default: runs in --dry-run unless you pass --apply.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACKER="${ROOT_DIR}/tools/todo_tracker.py"

usage() {
  cat <<'EOF'
Usage:
  tools/todo_bulk.sh <archive|invalidate|promote> <id...> [--apply]

IDs:
  - You can pass IDs separated by spaces and/or commas.
    Examples: "5 6 7" or "5,6,7" or "5,6 7"

Examples:
  # Preview only (default)
  tools/todo_bulk.sh archive 5 6 7 8
  tools/todo_bulk.sh archive 5,6,7,8

  # Actually write changes
  tools/todo_bulk.sh archive 5 6 7 8 --apply

Notes:
  - IDs come from: python3 tools/todo_tracker.py --pending --ids
  - By default this script runs todo_tracker.py with --dry-run for safety.
EOF
}

if [[ ${#} -lt 1 ]]; then
  usage
  exit 1
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ACTION="$1"; shift

APPLY=0
IDS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      # Split commas, keep whitespace-separated args as separate IDs.
      IFS=',' read -r -a parts <<<"$arg"
      for p in "${parts[@]}"; do
        p_trimmed="$(echo "$p" | xargs)"
        [[ -z "$p_trimmed" ]] && continue
        IDS+=("$p_trimmed")
      done
      ;;
  esac
done

if [[ ${#IDS[@]} -eq 0 ]]; then
  echo "No IDs provided." >&2
  usage
  exit 1
fi

case "$ACTION" in
  archive|invalidate|promote) ;;
  *)
    echo "Unknown action: $ACTION" >&2
    usage
    exit 1
    ;;
esac

EXTRA=()
if [[ $APPLY -eq 0 ]]; then
  EXTRA+=(--dry-run)
fi

for id in "${IDS[@]}"; do
  id_trimmed="$(echo "$id" | xargs)"
  [[ -z "$id_trimmed" ]] && continue
  printf "\n==> %s %s\n" "$ACTION" "$id_trimmed" >&2
  python3 "$TRACKER" --"$ACTION" "$id_trimmed" "${EXTRA[@]}"
done

if [[ $APPLY -eq 0 ]]; then
  printf "\n(dry-run only) Re-run with --apply to write changes.\n" >&2
fi
