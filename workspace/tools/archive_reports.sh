#!/usr/bin/env bash
set -euo pipefail

# Archive auto-generated reports under memory/ into memory/archive/.
# Default: dry-run (prints what it would do).
# Use --apply to actually move files.
#
# Targets (by default):
#   memory/housekeeping-*.md
#   memory/todo-scan-*.txt
#   memory/*housekeeping*.md   (optional; off by default)
#
# Examples:
#   bash tools/archive_reports.sh                 # dry-run, keep last 2 days
#   bash tools/archive_reports.sh --keep-days 3   # keep last 3 days
#   bash tools/archive_reports.sh --apply         # actually move
#   bash tools/archive_reports.sh --include-legacy-names
#   bash tools/archive_reports.sh --apply --no-update-index  # skip regenerating housekeeping_index.md
#   bash tools/archive_reports.sh --include-tmp             # also archive tmp/housekeeping*.md, tmp/todo-scan*.txt

APPLY=0
INCLUDE_LEGACY=0
INCLUDE_TMP=0
KEEP_DAYS=2
UPDATE_INDEX=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --include-legacy-names) INCLUDE_LEGACY=1; shift ;;
    --keep-days) KEEP_DAYS="${2:-}"; shift 2 ;;
    --include-tmp) INCLUDE_TMP=1; shift ;;
    --no-update-index) UPDATE_INDEX=0; shift ;;
    --update-index) UPDATE_INDEX=1; shift ;;
    -h|--help)
      sed -n '1,120p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

say() { echo "$@"; }
run() {
  if [[ $APPLY -eq 1 ]]; then
    "$@"
  else
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
  fi
}

# Keep the most recent N days of reports in memory/ root (default: 2).
# We only archive files whose embedded date is older than the cutoff.
cutoff_ymd() {
  local days="$1"
  if [[ -z "$days" ]]; then days=2; fi
  # cutoff = today - (days-1)
  local delta=$((days-1))
  date -d "- ${delta} day" +%F 2>/dev/null || date +%F
}

extract_ymd() {
  # Extract YYYY-MM-DD from common report names.
  # e.g. housekeeping-2026-02-08.md, housekeeping-2026-02-08-0700.md, todo-scan-2026-02-08.txt
  local bn
  bn="$(basename -- "$1")"
  if [[ "$bn" =~ ([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  echo ""
  return 1
}

shopt -s nullglob

declare -a FILES
FILES+=(memory/housekeeping-*.md)
FILES+=(memory/todo-scan-*.txt)

if [[ $INCLUDE_TMP -eq 1 ]]; then
  FILES+=(tmp/housekeeping*.md)
  FILES+=(tmp/todo-scan*.txt)
  FILES+=(tmp/todo_scan*.txt)
fi

if [[ $INCLUDE_LEGACY -eq 1 ]]; then
  # Some older ad-hoc names that can accumulate.
  FILES+=(memory/*housekeeping*.md)
  FILES+=(memory/*todo_scan*.txt)
fi

# De-dup (bash associative array).
declare -A SEEN
DECLARE_FILES=()
for f in "${FILES[@]}"; do
  for m in $f; do
    if [[ -z "${SEEN[$m]+x}" ]]; then
      SEEN[$m]=1
      DECLARE_FILES+=("$m")
    fi
  done
done

if [[ ${#DECLARE_FILES[@]} -eq 0 ]]; then
  say "No matching report files found."
  exit 0
fi

TS=$(date +%Y-%m-%d)
BASE_DIR="memory/archive/${TS}"
run mkdir -p "$BASE_DIR"

CUTOFF="$(cutoff_ymd "$KEEP_DAYS")"
say "Cutoff (keep-days=$KEEP_DAYS): keep >= $CUTOFF in memory/ root"

moved=0
skipped=0

for src in "${DECLARE_FILES[@]}"; do
  # Never archive the index
  if [[ "$(basename -- "$src")" == "housekeeping_index.md" ]]; then
    ((skipped++)) || true
    continue
  fi

  # Skip if already in archive
  if [[ "$src" == memory/archive/* ]]; then
    ((skipped++)) || true
    continue
  fi
  if [[ ! -f "$src" ]]; then
    ((skipped++)) || true
    continue
  fi

  # Respect keep-days cutoff
  src_ymd="$(extract_ymd "$src" || true)"
  if [[ -n "$src_ymd" && ( "$src_ymd" > "$CUTOFF" || "$src_ymd" == "$CUTOFF" ) ]]; then
    say "Keep (recent): $src"
    ((skipped++)) || true
    continue
  fi

  bn=$(basename "$src")
  # Avoid collisions when archiving tmp/ files that may share names with memory/ files.
  if [[ "$src" == tmp/* ]]; then
    bn="tmp-${bn}"
  fi
  dest="$BASE_DIR/$bn"
  if [[ -e "$dest" ]]; then
    say "Skip (exists): $dest"
    ((skipped++)) || true
    continue
  fi

  say "Archive: $src -> $dest"
  run mv -n "$src" "$dest"
  ((moved++)) || true
done

if [[ $APPLY -eq 1 && $UPDATE_INDEX -eq 1 && $moved -gt 0 ]]; then
  # Regenerate housekeeping_index.md so links stay accurate after archiving.
  # Note: this only touches the index; it does not move/delete anything else.
  if command -v python3 >/dev/null 2>&1; then
    run python3 tools/generate_housekeeping_index.py >/dev/null
    say "Updated: memory/housekeeping_index.md"
  else
    say "Note: python3 not found; skip updating housekeeping_index.md"
  fi
fi

say "Done. moved=$moved skipped=$skipped mode=$([[ $APPLY -eq 1 ]] && echo apply || echo dry-run)"
