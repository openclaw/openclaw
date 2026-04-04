#!/usr/bin/env node
// tools/ambient-recorder.js
//
// Asynchronous Ambient Reality (AAR) — local recording script.
// Run on creator's machine. Records 3min of mic audio every hour,
// applies privacy filter (muffles speech, keeps bird calls & traffic),
// uploads to static hosting.
//
// Usage:
//   node tools/ambient-recorder.js [--once] [--output ./public/cafe-game/assets]
//
// Requirements: ffmpeg installed and in PATH
//
// Privacy filter chain:
//   lowpass=f=1500     — cuts speech intelligibility (most speech 2-5kHz)
//   acompressor        — flattens dynamics so bird calls aren't drowned
//     threshold=-20dB  — start compressing above -20dB
//     ratio=4          — 4:1 compression
//     attack=5         — fast response (5ms)
//     release=50       — moderate release
//   volume=0.5         — normalize output level
//
// Output: latest_ambience.mp3 (~500KB for 3min at qscale:a 9)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────
const RECORD_SECONDS = 180;       // 3 minutes
const SAMPLE_RATE = 22050;        // low-fi is fine (telephone quality)
const OUTPUT_FILENAME = 'latest_ambience.mp3';
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour between recordings
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

// ── Resolve output directory ────────────────────────────────────
const args = process.argv.slice(2);
const once = args.includes('--once');
const outputIdx = args.indexOf('--output');
const outputDir = outputIdx >= 0 && args[outputIdx + 1]
  ? path.resolve(args[outputIdx + 1])
  : path.resolve(__dirname, '../projects/website/public/cafe-game/assets');

// ── Recording + processing ──────────────────────────────────────
function recordAndProcess() {
  const tmpRaw = path.join(require('os').tmpdir(), 'ambience_raw_' + Date.now() + '.wav');
  const outputPath = path.join(outputDir, OUTPUT_FILENAME);

  console.log(`[${new Date().toISOString()}] Recording ${RECORD_SECONDS}s...`);

  // Ensure output dir exists
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  try {
    // Step 1: Record from default microphone
    // -f avfoundation on macOS, -f pulse on Linux, -f dshow on Windows
    const platform = process.platform;
    let inputCmd;
    if (platform === 'darwin') {
      inputCmd = `-f avfoundation -i ":0" -t ${RECORD_SECONDS} -ar ${SAMPLE_RATE} -ac 1 "${tmpRaw}"`;
    } else if (platform === 'linux') {
      inputCmd = `-f pulse -i default -t ${RECORD_SECONDS} -ar ${SAMPLE_RATE} -ac 1 "${tmpRaw}"`;
    } else {
      inputCmd = `-f dshow -i audio="麦克风" -t ${RECORD_SECONDS} -ar ${SAMPLE_RATE} -ac 1 "${tmpRaw}"`;
    }

    execSync(`${FFMPEG} -y ${inputCmd} 2>/dev/null`, { timeout: (RECORD_SECONDS + 10) * 1000 });

    // Step 2: Privacy filter + encode to MP3
    // lowpass=1500: removes speech clarity (speech formants 2-5kHz)
    // acompressor: flattens dynamics, preserves bird chirps & traffic hum
    const filterChain = [
      'lowpass=f=1500',                    // kill speech intelligibility
      'acompressor=threshold=-20dB:ratio=4:attack=5:release=50', // even out dynamics
      'volume=0.5',                         // normalize
    ].join(',');

    const cmd = `${FFMPEG} -y -i "${tmpRaw}" -af "${filterChain}" -codec:a libmp3lame -qscale:a 9 "${outputPath}" 2>/dev/null`;

    console.log(`[${new Date().toISOString()}] Processing (privacy filter)...`);
    execSync(cmd, { timeout: 30000 });

    const sizeKB = Math.round(fs.statSync(outputPath).size / 1024);
    console.log(`[${new Date().toISOString()}] Done → ${outputPath} (${sizeKB}KB)`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
  } finally {
    // Cleanup temp file
    try { fs.unlinkSync(tmpRaw); } catch (_) {}
  }
}

// ── Main loop ───────────────────────────────────────────────────
console.log(`Ambient Recorder — output: ${outputDir}`);
console.log(`Platform: ${process.platform}, ffmpeg: ${FFMPEG}`);
console.log(`Mode: ${once ? 'once' : 'every ' + (INTERVAL_MS / 60000) + 'min'}`);

recordAndProcess();

if (!once) {
  console.log(`Next recording in ${INTERVAL_MS / 60000} minutes...`);
  setInterval(recordAndProcess, INTERVAL_MS);
}
