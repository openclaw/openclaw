#!/bin/bash
set -euo pipefail

REMOTE_URL="git@github.com-openclaw-backup:openclaw-systems/openclaw-backup.git"
DRILL="/tmp/openclaw-restore-drill-$(date +%Y-%m-%d_%H-%M-%S)"
EXPECTED="$(git ls-remote --heads "$REMOTE_URL" main | awk "{print \$1}")"

git clone --depth 1 "$REMOTE_URL" "$DRILL"
CLONED="$(git -C "$DRILL" rev-parse HEAD)"
[ "$CLONED" = "$EXPECTED" ]

for f in \
  "package.json" \
  "pnpm-lock.yaml" \
  "work/GITHUB_BACKUP_RESTORE.md" \
  "work/scripts/backup-sync-github.sh" \
  "work/scripts/backup-restore-drill.sh"
do
  [ -e "$DRILL/$f" ]
done

[ ! -e "$DRILL/.github/workflows" ]

cd "$DRILL"
CI=1 pnpm install --frozen-lockfile
echo "RESTORE_DRILL_OK $(date +%Y-%m-%d_%H-%M-%S) $CLONED"
