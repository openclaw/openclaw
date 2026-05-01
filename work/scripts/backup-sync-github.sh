#!/bin/bash
set -euo pipefail

SRC="/Users/openclaw/OpenClaw"
DEST="/Users/openclaw/.openclaw-backup-workspace"
TMPDIR_STAGE="${TMPDIR:-/tmp}/openclaw-backup-stage.$$"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
MSG="checkpoint: automated OpenClaw backup snapshot ${STAMP}"

cleanup() {
  rm -rf "$TMPDIR_STAGE"
}
trap cleanup EXIT

mkdir -p "$TMPDIR_STAGE"

# Rebuild working tree from current source HEAD only, never from source history.
git -C "$SRC" archive HEAD | tar -x -C "$TMPDIR_STAGE"

# Sync snapshot into clean backup workspace.
rsync -a --delete --exclude ".git/" "$TMPDIR_STAGE"/ "$DEST"/

# Commit only if snapshot content changed.
git -C "$DEST" add -A

# Force-add restore-critical tracked files that source policy may ignore.
if [ -f "$DEST/pnpm-lock.yaml" ]; then
  git -C "$DEST" add -f -- pnpm-lock.yaml
fi

if git -C "$DEST" diff --cached --quiet; then
  echo "NO_CHANGES"
  exit 0
fi

git -C "$DEST" commit -m "$MSG"
git -C "$DEST" push origin main

echo "PUSHED"
git -C "$DEST" log -1 --format="%H %an <%ae> %s"
