#!/bin/bash
set -euo pipefail

SRC="/Users/openclaw/OpenClaw"
DEST="/Users/openclaw/.openclaw-backup-workspace"
LOG_DIR="/Users/openclaw/.openclaw-backup-logs"
LAST_SUCCESS="$LOG_DIR/last-success.json"
TMPDIR_STAGE="${TMPDIR:-/tmp}/openclaw-backup-stage.$$"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
MSG="checkpoint: automated OpenClaw backup snapshot ${STAMP}"

cleanup() {
  rm -rf "$TMPDIR_STAGE"
}
trap cleanup EXIT

write_success_record() {
  local result="$1"
  local recorded_at_local
  local source_head
  local backup_workspace_head
  local backup_workspace_head_subject

  mkdir -p "$LOG_DIR"
  recorded_at_local="$(date +%Y-%m-%dT%H:%M:%S%z)"
  source_head="$(git -C "$SRC" rev-parse HEAD)"
  backup_workspace_head="$(git -C "$DEST" rev-parse HEAD)"
  backup_workspace_head_subject="$(git -C "$DEST" log -1 --format=%s)"

  node - "$LAST_SUCCESS" "$recorded_at_local" "$result" "$source_head" "$backup_workspace_head" "$backup_workspace_head_subject" <<'NODE'
const fs = require("node:fs");
const [path, recordedAtLocal, result, sourceHead, backupWorkspaceHead, backupWorkspaceHeadSubject] =
  process.argv.slice(2);

fs.writeFileSync(
  path,
  `${JSON.stringify(
    {
      recorded_at_local: recordedAtLocal,
      status: "success",
      result,
      source_head: sourceHead,
      backup_workspace_head: backupWorkspaceHead,
      backup_workspace_head_subject: backupWorkspaceHeadSubject,
    },
    null,
    2,
  )}\n`,
);
NODE
}

ensure_monthly_anchor() {
  local tag

  tag="backup-$(date +%Y-%m)"
  if git -C "$DEST" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
    return 0
  fi

  if ! git -C "$DEST" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    git -C "$DEST" tag -a "$tag" -m "monthly backup anchor $tag" HEAD
  fi

  git -C "$DEST" push origin "refs/tags/$tag"
}

mkdir -p "$TMPDIR_STAGE"

# Rebuild working tree from current source HEAD only, never from source history.
git -C "$SRC" archive HEAD | tar -x -C "$TMPDIR_STAGE"

# Backup snapshots must not carry executable GitHub Actions workflows.
rm -rf "$TMPDIR_STAGE/.github/workflows"

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
  ensure_monthly_anchor
  write_success_record "no_changes"
  exit 0
fi

git -C "$DEST" commit -m "$MSG"
git -C "$DEST" push origin main
ensure_monthly_anchor
write_success_record "pushed"

echo "PUSHED"
git -C "$DEST" log -1 --format="%H %an <%ae> %s"
