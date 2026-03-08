#!/usr/bin/env bash
# Sync fork with upstream, rebase rocobot, build via GH Actions, and redeploy.
#
# Usage:
#   bash /root/openclaw-fork/upgrade.sh          # sync + rebase + build + deploy
#   bash /root/openclaw-fork/upgrade.sh --skip-sync   # just trigger build + deploy
#   bash /root/openclaw-fork/upgrade.sh --deploy-only  # download latest artifact + deploy
set -euo pipefail

FORK_DIR="/root/openclaw-fork"
REPO="rocodeveloper/openclaw"
BRANCH="rocobot"
ARTIFACT_DIR="/tmp/openclaw-build"

cd "$FORK_DIR"

skip_sync=false
deploy_only=false
for arg in "$@"; do
  case "$arg" in
    --skip-sync) skip_sync=true ;;
    --deploy-only) deploy_only=true ;;
  esac
done

# ── Sync upstream + rebase ──────────────────────────────────────
if [[ "$deploy_only" == false && "$skip_sync" == false ]]; then
  echo "=== Syncing fork main with upstream ==="
  gh repo sync "$REPO" --branch main 2>&1 || true

  echo "=== Fetching updated main ==="
  git fetch origin main

  echo "=== Rebasing $BRANCH onto main ==="
  git checkout "$BRANCH"
  if ! git rebase origin/main; then
    echo "ERROR: Rebase has conflicts. Resolve manually then re-run with --skip-sync"
    exit 1
  fi

  echo "=== Pushing rebased $BRANCH ==="
  git push --force origin "$BRANCH"
  echo "Push triggers build workflow automatically."
fi

# ── Build via GH Actions ────────────────────────────────────────
if [[ "$deploy_only" == false ]]; then
  echo "=== Waiting for build workflow ==="
  # Wait for the run to appear
  sleep 5
  RUN_ID=$(gh run list --repo "$REPO" --branch "$BRANCH" --workflow "Build Fork" --limit 1 --json databaseId --jq '.[0].databaseId')
  if [[ -z "$RUN_ID" ]]; then
    echo "ERROR: No build run found. Check GitHub Actions."
    exit 1
  fi
  echo "Build run: https://github.com/$REPO/actions/runs/$RUN_ID"

  if ! gh run watch "$RUN_ID" --repo "$REPO" --exit-status; then
    echo "ERROR: Build failed. Check logs at https://github.com/$REPO/actions/runs/$RUN_ID"
    exit 1
  fi
fi

# ── Download artifact ───────────────────────────────────────────
echo "=== Downloading build artifact ==="
rm -rf "$ARTIFACT_DIR"

if [[ "$deploy_only" == true ]]; then
  RUN_ID=$(gh run list --repo "$REPO" --branch "$BRANCH" --workflow "Build Fork" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
  if [[ -z "$RUN_ID" ]]; then
    echo "ERROR: No successful build found."
    exit 1
  fi
fi

gh run download "$RUN_ID" --repo "$REPO" --name openclaw-fork --dir "$ARTIFACT_DIR"
TARBALL=$(ls "$ARTIFACT_DIR"/openclaw-*.tgz 2>/dev/null | head -1)
if [[ -z "$TARBALL" ]]; then
  echo "ERROR: No tarball found in artifact."
  exit 1
fi
echo "Artifact: $TARBALL"

# ── Deploy ──────────────────────────────────────────────────────
echo "=== Stopping gateway ==="
systemctl --user stop openclaw-gateway

echo "=== Installing $TARBALL ==="
npm install -g "$TARBALL"

echo "=== Starting gateway ==="
systemctl --user start openclaw-gateway

sleep 3
systemctl --user status openclaw-gateway --no-pager | head -5
echo ""
echo "=== Deployed $(openclaw --version) ==="
