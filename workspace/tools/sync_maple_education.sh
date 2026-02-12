#!/usr/bin/env bash
set -euo pipefail

SRC="/mnt/ugreen/leo/maple education/"
DST="/home/leonard/Documents/LeonardVault/Projects/Maple_Education_full/"
LOG_DIR="/home/leonard/clawd/logs"
mkdir -p "$LOG_DIR" "$DST"

STAMP=$(date +"%Y-%m-%d %H:%M:%S")
LOG_FILE="$LOG_DIR/sync_maple_education.log"

{
  echo "[$STAMP] sync start"
  rsync -a --update --human-readable --stats \
    --exclude ".sync/" \
    --exclude "#recycle/" \
    "$SRC" "$DST"
  echo "[$STAMP] sync done"
  echo
} >> "$LOG_FILE" 2>&1
