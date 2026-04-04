#!/usr/bin/env bash
# ============================================================
#  Soundscape Deploy — push latest ambience to Vercel
#  Called by pipeline.sh or manually. Commits + pushes asset.
# ============================================================

set -euo pipefail

REPO="/Users/sulaxd/clawd/website"
HOUR=$(date +%H)

cd "$REPO"

# Check if there are actual audio changes
if git diff --quiet projects/website/public/cafe-game/assets/; then
  echo "No audio changes to deploy"
  exit 0
fi

git add projects/website/public/cafe-game/assets/latest_ambience.mp3
git add projects/website/public/cafe-game/assets/ambience_h*.mp3 2>/dev/null || true

git commit -m "soundscape: hour ${HOUR} ambient recording [auto]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

git push origin main

echo "Deployed hour ${HOUR} soundscape to Vercel"
