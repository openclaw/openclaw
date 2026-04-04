#!/usr/bin/env bash
# ============================================================
#  Perpetual Soundscape Pipeline — 永續聲景採集系統
#  Runs every hour via cron/launchd on Cruz's MacBook.
#
#  Flow:
#    1. RECORD    — 3 min raw from MacBook mic
#    2. ANALYZE   — RMS loudness + silence detection
#    2.5 CLASSIFY — Schafer ESC: split into keynote/signal/soundmark pools
#    3. SELECT    — pick best 90s from keynote pool (steady ambient)
#    4. PROCESS   — noise gate, normalize, crossfade loop, compress
#    5. TAG       — embed hour-of-day metadata (for time-aware playback)
#    6. UPLOAD    — push to Vercel via API, update latest_ambience.mp3
#    7. ARCHIVE   — keep 24hr rolling archive (one per hour slot)
# ============================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────
WORKSPACE="${HOME}/.soundscape"
RAW_DIR="${WORKSPACE}/raw"
PROCESSED_DIR="${WORKSPACE}/processed"
ARCHIVE_DIR="${WORKSPACE}/archive"
UPLOAD_DIR="${WORKSPACE}/upload"
POOLS_DIR="${WORKSPACE}/pools"
LOG_FILE="${WORKSPACE}/pipeline.log"

RECORD_SECONDS=${RECORD_SECONDS:-180}   # 3 minutes raw (overridable)
SEGMENT_SECONDS=${SEGMENT_SECONDS:-90}  # best 90s selected (overridable)
CROSSFADE_SECONDS=5       # loop crossfade overlap (auto-adjusted by stitch.py)
OUTPUT_BITRATE="96k"      # MP3 quality (96k ≈ 1.1MB/90s)
MIC_DEVICE=":MacBook Pro的麥克風"   # avfoundation input
SMART_RECORD=${SMART_RECORD:-0}  # 1=event-driven recording (wait for quiet state)

# Vercel deploy target (static asset via git push)
REPO_ASSETS="/Users/sulaxd/clawd/website/projects/website/public/cafe-game/assets"

HOUR=$(date +%H)
TIMESTAMP=$(date +%Y%m%d_%H%M)

mkdir -p "$RAW_DIR" "$PROCESSED_DIR" "$ARCHIVE_DIR" "$UPLOAD_DIR" "$POOLS_DIR"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# ── 1. RECORD ──────────────────────────────────────────────
RAW_FILE="${RAW_DIR}/${TIMESTAMP}_raw.wav"

if [ "$SMART_RECORD" = "1" ]; then
  # Event-driven recording: monitor RMS + spectral flatness, only record
  # when environment enters "pure keynote state" (low RMS, high flatness).
  # Pre-record up to 30s of monitoring to detect quiet windows.
  log "RECORD: smart mode — waiting for pure keynote state"
  PROBE_FILE="${RAW_DIR}/${TIMESTAMP}_probe.wav"
  PROBE_SECONDS=10

  MAX_ATTEMPTS=12  # 12 x 10s = 2 min max wait
  ATTEMPT=0
  QUIET_DETECTED=0

  while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    ffmpeg -y -f avfoundation -i "$MIC_DEVICE" \
      -t "$PROBE_SECONDS" -ar 44100 -ac 1 \
      -loglevel warning "$PROBE_FILE" 2>/dev/null

    # Check RMS and spectral flatness via sox
    RMS=$(sox "$PROBE_FILE" -n stat 2>&1 | grep "RMS.*amplitude" | head -1 | awk '{print $3}')
    # Rough flatness proxy: ratio of mean amplitude to RMS (closer to 1 = flatter spectrum)
    MEAN=$(sox "$PROBE_FILE" -n stat 2>&1 | grep "Mean.*norm" | awk '{print $3}')

    # Pure keynote state: RMS < 0.01 (quiet) — indicates no loud transients
    IS_QUIET=$(echo "${RMS:-1} < 0.01" | bc -l 2>/dev/null || echo 0)

    if [ "$IS_QUIET" = "1" ]; then
      log "RECORD: quiet state detected (RMS=${RMS}, attempt=${ATTEMPT}), recording ${RECORD_SECONDS}s"
      QUIET_DETECTED=1
      break
    fi
    log "RECORD: probe ${ATTEMPT}/${MAX_ATTEMPTS} — RMS=${RMS}, waiting for quiet..."
  done
  rm -f "$PROBE_FILE"

  if [ "$QUIET_DETECTED" = "0" ]; then
    log "RECORD: no quiet window found after ${MAX_ATTEMPTS} probes, recording anyway"
  fi
fi

log "RECORD: ${RECORD_SECONDS}s from mic → ${RAW_FILE}"

ffmpeg -y -f avfoundation -i "$MIC_DEVICE" \
  -t "$RECORD_SECONDS" -ar 44100 -ac 1 \
  -loglevel warning "$RAW_FILE"

if [ ! -s "$RAW_FILE" ]; then
  log "ERROR: Recording failed or empty"
  exit 1
fi

# ── 2. ANALYZE — find loudest non-clipping segment ─────────
log "ANALYZE: scanning for best ${SEGMENT_SECONDS}s segment"

# Get total duration
DURATION=$(sox "$RAW_FILE" -n stat 2>&1 | grep "Length" | awk '{print $3}' | cut -d. -f1)
DURATION=${DURATION:-$RECORD_SECONDS}

# Scan in 10s steps, pick segment with highest RMS that doesn't clip
BEST_START=0
BEST_RMS=0

for START in $(seq 0 10 $((DURATION - SEGMENT_SECONDS))); do
  RMS=$(sox "$RAW_FILE" -n trim "$START" "$SEGMENT_SECONDS" stat 2>&1 \
    | grep "RMS.*amplitude" | head -1 | awk '{print $3}')
  PEAK=$(sox "$RAW_FILE" -n trim "$START" "$SEGMENT_SECONDS" stat 2>&1 \
    | grep "Maximum amplitude" | awk '{print $3}')

  # Skip if clipping (peak > 0.95) or too quiet (RMS < 0.001)
  if [ -z "$RMS" ]; then continue; fi

  CLIP=$(echo "$PEAK > 0.95" | bc -l 2>/dev/null || echo 0)
  QUIET=$(echo "$RMS < 0.001" | bc -l 2>/dev/null || echo 0)

  if [ "$CLIP" = "0" ] && [ "$QUIET" = "0" ]; then
    BETTER=$(echo "$RMS > $BEST_RMS" | bc -l 2>/dev/null || echo 0)
    if [ "$BETTER" = "1" ]; then
      BEST_START=$START
      BEST_RMS=$RMS
    fi
  fi
done

log "ANALYZE: best segment at ${BEST_START}s (RMS: ${BEST_RMS})"

# ── 2.5 CLASSIFY — Schafer ESC heuristic pools ───────────
log "CLASSIFY: running Schafer soundscape classifier"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CLASSIFY_OUTPUT=$(python3 "${SCRIPT_DIR}/classify.py" "$RAW_FILE" --out-dir "$PROCESSED_DIR" 2>&1) || {
  log "CLASSIFY: WARNING — classifier failed, falling back to full raw file"
  CLASSIFY_OUTPUT=""
}

if [ -n "$CLASSIFY_OUTPUT" ]; then
  log "CLASSIFY: $(echo "$CLASSIFY_OUTPUT" | grep 'classified:' || true)"

  # Find the keynote pool WAV (most recent in pools dir)
  KEYNOTE_WAV=$(ls -t "${POOLS_DIR}"/keynote_*.wav 2>/dev/null | head -1)
  SIGNAL_WAV=$(ls -t "${POOLS_DIR}"/signal_*.wav 2>/dev/null | head -1)
  SOUNDMARK_WAV=$(ls -t "${POOLS_DIR}"/soundmark_*.wav 2>/dev/null | head -1)

  [ -n "$SIGNAL_WAV" ] && log "CLASSIFY: signal pool saved → ${SIGNAL_WAV}"
  [ -n "$SOUNDMARK_WAV" ] && log "CLASSIFY: soundmark pool saved → ${SOUNDMARK_WAV}"
fi

# ── 3. SELECT — extract best segment (prefer keynote pool) ─
SEGMENT_FILE="${PROCESSED_DIR}/${TIMESTAMP}_segment.wav"

if [ -n "${KEYNOTE_WAV:-}" ] && [ -s "${KEYNOTE_WAV:-}" ]; then
  # Use keynote pool as the ambient source
  KEYNOTE_DURATION=$(sox "$KEYNOTE_WAV" -n stat 2>&1 | grep "Length" | awk '{print $3}' | cut -d. -f1)
  KEYNOTE_DURATION=${KEYNOTE_DURATION:-0}

  if [ "$KEYNOTE_DURATION" -ge "$SEGMENT_SECONDS" ]; then
    # Keynote pool is long enough — extract best 90s from it
    log "SELECT: using keynote pool (${KEYNOTE_DURATION}s available)"
    sox "$KEYNOTE_WAV" "$SEGMENT_FILE" trim 0 "$SEGMENT_SECONDS"
  else
    # Keynote pool too short — fall back to raw file best-segment
    log "SELECT: keynote pool too short (${KEYNOTE_DURATION}s), falling back to raw"
    sox "$RAW_FILE" "$SEGMENT_FILE" trim "$BEST_START" "$SEGMENT_SECONDS"
  fi
else
  log "SELECT: no keynote pool available, using raw best-segment"
  sox "$RAW_FILE" "$SEGMENT_FILE" trim "$BEST_START" "$SEGMENT_SECONDS"
fi

# ── 4. PROCESS ─────────────────────────────────────────────
PROCESSED_FILE="${PROCESSED_DIR}/${TIMESTAMP}_processed.wav"
LOOP_FILE="${PROCESSED_DIR}/${TIMESTAMP}_loop.wav"
FINAL_MP3="${UPLOAD_DIR}/latest_ambience.mp3"

log "PROCESS: noise gate + normalize + spectral crossfade loop"

# Noise gate (remove silence below -40dB) + normalize to -3dB (SOX is great at this)
sox "$SEGMENT_FILE" "$PROCESSED_FILE" \
  compand 0.02,0.2 -40,-40,-30,-10,0,0 -3 \
  norm -3

# Spectral crossfade with adaptive overlap + granular fallback
# stitch.py auto-adjusts: overlap=min(requested, duration/3)
# Falls back to granular synthesis if source < 4.5s (min viable keynote)
SEGMENT_DURATION=$(sox "$PROCESSED_FILE" -n stat 2>&1 | grep "Length" | awk '{print $3}' | cut -d. -f1)
SEGMENT_DURATION=${SEGMENT_DURATION:-0}
log "PROCESS: segment ${SEGMENT_DURATION}s, requested overlap ${CROSSFADE_SECONDS}s"

python3 "${SCRIPT_DIR}/spectral_stitch.py" \
  "$PROCESSED_FILE" "$LOOP_FILE" \
  --overlap "$CROSSFADE_SECONDS" \
  --target-duration 60

# Convert to MP3
ffmpeg -y -i "$LOOP_FILE" -b:a "$OUTPUT_BITRATE" -ar 44100 -ac 1 \
  -metadata title="Thinker Cafe Soundscape" \
  -metadata artist="Cruz's Space" \
  -metadata comment="hour=${HOUR}" \
  -loglevel warning "$FINAL_MP3"

FILESIZE=$(du -h "$FINAL_MP3" | awk '{print $1}')
log "PROCESS: output ${FINAL_MP3} (${FILESIZE})"

# ── 5. ARCHIVE — 24hr rolling (one per hour slot) ─────────
ARCHIVE_FILE="${ARCHIVE_DIR}/hour_${HOUR}.mp3"
cp "$FINAL_MP3" "$ARCHIVE_FILE"
log "ARCHIVE: saved to ${ARCHIVE_FILE}"

# ── 6. DEPLOY — copy to repo assets ───────────────────────
cp "$FINAL_MP3" "${REPO_ASSETS}/latest_ambience.mp3"

# Also copy hour-tagged version for time-aware playback
cp "$FINAL_MP3" "${REPO_ASSETS}/ambience_h${HOUR}.mp3"

log "DEPLOY: copied to ${REPO_ASSETS}/"

# ── 7. CLEANUP ─────────────────────────────────────────────
rm -f "$RAW_FILE" "$SEGMENT_FILE" "$PROCESSED_FILE" "$LOOP_FILE"

log "DONE: hour ${HOUR} soundscape ready"
log "============================================"
