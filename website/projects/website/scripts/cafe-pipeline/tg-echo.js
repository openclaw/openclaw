#!/usr/bin/env node
/**
 * tg-echo.js — TG Echo Pipeline (read-only bulletin board)
 *
 * Reads Cruz's recent public TG messages via wuji CLI,
 * sanitizes sensitive content, outputs tg-echo.json for Cafe to display.
 *
 * Usage:
 *   node tg-echo.js
 *   node tg-echo.js --bridge dufu
 *   node tg-echo.js --limit 5
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Config ──────────────────────────────────────────────────
const OUTPUT_DIR = path.join(__dirname, '../../public/cafe-game/data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'tg-echo.json');
const WUJI = '/opt/homebrew/bin/wuji';
const DEFAULT_BRIDGE = 'dufu';
const DEFAULT_LIMIT = 5;

// ── Sanitization ────────────────────────────────────────────
// Strip chat IDs, phone numbers, private identifiers
const SANITIZE_PATTERNS = [
  { pattern: /-?\d{10,}/g, replace: '[ID]' },           // chat IDs / user IDs
  { pattern: /\+?\d{2,4}[\s-]?\d{6,}/g, replace: '[phone]' }, // phone numbers
  { pattern: /https?:\/\/t\.me\/\S+/g, replace: '[link]' },   // TG invite links
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replace: '[email]' },
];

function sanitize(text) {
  let result = text;
  for (const { pattern, replace } of SANITIZE_PATTERNS) {
    result = result.replace(pattern, replace);
  }
  return result.trim();
}

// ── Parse wuji tg output ────────────────────────────────────
// wuji tg <chat> --my returns lines like:
//   [2026-04-04 15:30] Cruz: message text here
function parseMessages(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const messages = [];

  for (const line of lines) {
    // Match timestamp pattern: [YYYY-MM-DD HH:MM]
    const match = line.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*(.+?):\s*(.+)$/);
    if (match) {
      messages.push({
        time: match[1],
        sender: match[2].trim(),
        text: sanitize(match[3]),
      });
    }
  }

  return messages;
}

// ── Main ────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const bridgeIdx = args.indexOf('--bridge');
  const bridge = bridgeIdx >= 0 ? args[bridgeIdx + 1] : DEFAULT_BRIDGE;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : DEFAULT_LIMIT;

  // Get Cruz's saved messages (SM) — the safest public-facing content
  let raw = '';
  try {
    raw = execSync(`${WUJI} tg --bridge ${bridge} sm --my ${limit * 2}`, {
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (err) {
    // Fallback: try reading saved messages without --my flag
    try {
      raw = execSync(`${WUJI} tg --bridge ${bridge} sm ${limit * 2}`, {
        encoding: 'utf-8',
        timeout: 15000,
      });
    } catch {
      console.error('[tg-echo] Failed to fetch TG messages:', err.message);
      // Write empty state
      const empty = { messages: [], updated_at: new Date().toISOString(), source: bridge };
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(empty, null, 2));
      return;
    }
  }

  const allMessages = parseMessages(raw);

  // Only keep Cruz's own messages, limit count
  const cruzMessages = allMessages
    .filter(m => /cruz|dufu|andrew|杜甫/i.test(m.sender))
    .slice(0, limit)
    .map(m => ({
      time: m.time,
      text: m.text,
    }));

  const output = {
    messages: cruzMessages,
    updated_at: new Date().toISOString(),
    source: bridge,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[tg-echo] Wrote ${cruzMessages.length} messages to tg-echo.json`);
}

main();
