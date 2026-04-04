#!/usr/bin/env node
/**
 * harvest-echo.js — Yesterday's Echo (T-1) Pipeline
 *
 * Reads terminal/git history, classifies into life states,
 * outputs creator-state.json for Canvas to consume.
 *
 * Usage:
 *   node harvest-echo.js                    # parse mock-history.log
 *   node harvest-echo.js --source git       # parse real git log (TODO)
 *   node harvest-echo.js --date 2026-04-03  # specific date
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Config ──────────────────────────────────────────────────
const OUTPUT_DIR = path.join(__dirname, '../../public/cafe-game/data');
const MOCK_LOG = path.join(__dirname, 'mock-history.log');

// ── Git repos to scan when --source git ─────────────────────
const GIT_REPOS = [
  { path: '/Users/sulaxd/clawd', label: 'clawd' },
  { path: '/Users/sulaxd/clawd/website', label: 'cafe' },
  { path: '/Users/sulaxd/Documents/幣塔', label: 'bita' },
  { path: '/Users/sulaxd/Documents/two', label: 'bg666' },
  { path: '/Users/sulaxd/Documents/24bet', label: 'g9' },
  { path: '/Users/sulaxd/Documents/18-websites-18-weeks', label: 'teaching' },
];

// ── State classification rules ──────────────────────────────
// Priority: first match wins. Order matters.
const STATE_RULES = [
  { pattern: /sleep|went to bed|晚安/i,         state: 'sleeping' },
  { pattern: /meditation|冥想|meditat/i,         state: 'meditating' },
  { pattern: /piano|guitar|music|練琴/i,         state: 'playing' },
  { pattern: /reading|看書|閱讀/i,               state: 'reading' },
  { pattern: /lunch|dinner|breakfast|吃飯|公園|park|family|兒子/i, state: 'out' },
  { pattern: /git commit|git push|vim|node|pnpm|curl|deploy/i,    state: 'coding' },
  { pattern: /git log|git diff|git status/i,     state: 'coding' },
];

// ── Vibe translations per state ─────────────────────────────
// Each state has multiple possible vibes; pick by hour mood
const VIBE_TEMPLATES = {
  coding: [
    '在磨像素。你知道嗎，有時候一個反光角度可以調一整晚。',
    '寫了幾個 commit，改善咖啡廳的燈光。像是在調一盞真的檯燈。',
    '在跟一個 bug 搏鬥。像水管漏水一樣，知道在漏，但找不到是哪根。',
    '部署完新版本了。每次按下 push 都像把一封信丟進郵筒。',
  ],
  sleeping: [
    '在休息。連機器都需要停機維護的。',
    '睡了。夢裡可能還在寫 code。',
  ],
  meditating: [
    '在冥想。什麼都不想的時候，反而想得最清楚。',
    '靜坐中。呼吸就是最好的 debugger。',
  ],
  out: [
    '出門了。帶兒子去公園轉了一圈，曬曬太陽。',
    '不在店裡。有時候離開螢幕才看得到全貌。',
  ],
  playing: [
    '在練琴。波希米亞狂想曲的那段和弦進行，跟重構代碼一樣需要肌肉記憶。',
    '彈了一會兒鋼琴。手指碰到琴鍵的觸感，跟打字完全不同。',
  ],
  reading: [
    '在看書。今天翻的是工程與科學的藝術，每一頁都像在跟大師對話。',
    '讀書中。紙本書有一種螢幕給不了的安靜。',
  ],
};

// ── Parse log lines ─────────────────────────────────────────
function parseLine(line) {
  line = line.trim();
  if (!line) return null;

  // Format: 2026-04-03T08:15:44 <command or comment>
  var match = line.match(/^(\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):\d{2})\s+(.+)$/);
  if (!match) return null;

  var timestamp = match[1];
  var hour = parseInt(match[2], 10);
  var minute = parseInt(match[3], 10);
  var content = match[4].replace(/^#\s*/, ''); // strip comment marker

  return { timestamp, hour, minute, content };
}

function classifyState(content) {
  for (var rule of STATE_RULES) {
    if (rule.pattern.test(content)) return rule.state;
  }
  return 'coding'; // default: if they're in terminal, they're coding
}

// ── Sanitize sensitive data ─────────────────────────────────
function sanitize(content) {
  return content
    .replace(/--password[= ]\S+/g, '--password [REDACTED]')
    .replace(/token[= ]\S+/gi, 'token=[REDACTED]')
    .replace(/Bearer \S+/g, 'Bearer [REDACTED]')
    .replace(/\/Users\/\w+/g, '/Users/***')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '***.***.***.***');
}

// ── Build timeline from parsed entries ──────────────────────
function buildTimeline(entries) {
  if (!entries.length) return [];

  var timeline = [];
  var currentState = null;
  var currentBlock = null;

  for (var entry of entries) {
    var state = classifyState(entry.content);
    var clean = sanitize(entry.content);

    if (state !== currentState) {
      // New state block
      if (currentBlock) timeline.push(currentBlock);
      currentState = state;
      currentBlock = {
        hour: entry.hour,
        minute: entry.minute,
        state: state,
        activities: [clean],
        raw_count: 1,
      };
    } else {
      // Same state, accumulate
      currentBlock.activities.push(clean);
      currentBlock.raw_count++;
    }
  }
  if (currentBlock) timeline.push(currentBlock);

  return timeline;
}

// ── Assign vibes to timeline blocks ─────────────────────────
function assignVibes(timeline) {
  return timeline.map(function (block, idx) {
    var templates = VIBE_TEMPLATES[block.state] || VIBE_TEMPLATES.coding;
    // Pick template based on block index (deterministic but varied)
    var vibe = templates[idx % templates.length];

    // Extract commit messages for coding blocks (the interesting part)
    // Supports both mock-log style "git commit -m "msg"" and git-source style "[label] msg"
    var commits = block.activities
      .map(function (a) {
        // git-source format: "[label] subject"
        var gitSrc = a.match(/^\[[\w\d]+\]\s+(.+)$/);
        if (gitSrc) return gitSrc[1];
        // mock-log format: git commit -m "msg"
        var mockLog = a.match(/-m\s+"([^"]+)"/);
        if (mockLog) return mockLog[1];
        return null;
      })
      .filter(Boolean);

    return {
      hour: block.hour,
      state: block.state,
      vibe: vibe,
      commits: commits.length ? commits : undefined,
      intensity: Math.min(block.raw_count / 5, 1), // 0-1 activity density
    };
  });
}

// ── Derive dominant mood ────────────────────────────────────
function dominantMood(timeline) {
  var counts = {};
  for (var block of timeline) {
    var duration = 1; // rough: each block = 1 unit
    counts[block.state] = (counts[block.state] || 0) + duration;
  }
  var sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0] ? sorted[0][0] : 'coding';
}

// ── Harvest entries from git log ─────────────────────────────
function harvestFromGit(dateStr) {
  var nextDay = new Date(dateStr);
  nextDay.setDate(nextDay.getDate() + 1);
  var nextDayStr = nextDay.toISOString().slice(0, 10);

  var allEntries = [];

  for (var repo of GIT_REPOS) {
    if (!fs.existsSync(repo.path)) {
      console.log('harvest-echo: skipping ' + repo.label + ' (path not found)');
      continue;
    }

    try {
      var cmd = [
        'git', '-C', JSON.stringify(repo.path),
        'log',
        '--after=' + dateStr + 'T00:00:00',
        '--before=' + nextDayStr + 'T00:00:00',
        '--format="%aI %s"',
        '--all',
      ].join(' ') + ' 2>/dev/null';

      var output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
      var lines = output.split('\n');

      for (var line of lines) {
        line = line.trim();
        if (!line) continue;

        // Format: 2026-04-03T08:15:44+08:00 commit message
        // Split on first space after the ISO timestamp (which includes timezone offset)
        var tsEnd = line.search(/\s/);
        if (tsEnd === -1) continue;
        var isoTs = line.slice(0, tsEnd);
        var subject = line.slice(tsEnd + 1).trim();
        if (!subject || !isoTs.match(/^\d{4}-\d{2}-\d{2}T/)) continue;

        // Parse hour/minute from the ISO string directly
        var timePart = isoTs.slice(11, 19); // HH:MM:SS
        var hour = parseInt(timePart.slice(0, 2), 10);
        var minute = parseInt(timePart.slice(3, 5), 10);

        // Normalize timestamp to local-ish ISO without offset for sorting
        var localTs = isoTs.slice(0, 19);

        allEntries.push({
          timestamp: localTs,
          hour: hour,
          minute: minute,
          content: '[' + repo.label + '] ' + subject,
        });
      }

      console.log('harvest-echo: ' + repo.label + ' scanned');
    } catch (e) {
      console.log('harvest-echo: ' + repo.label + ' git error, skipping');
    }
  }

  // Sort by timestamp (ISO strings are lexicographically sortable)
  allEntries.sort(function (a, b) {
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
  });

  return allEntries;
}

// ── GLM enhancement (optional) ───────────────────────────────
function enhanceWithGLM(summary, timeline) {
  var GLM = '/Users/sulaxd/.local/bin/glm';
  if (!fs.existsSync(GLM)) return summary;

  var commits = timeline
    .filter(function (b) { return b.commits && b.commits.length; })
    .reduce(function (acc, b) { return acc.concat(b.commits); }, [])
    .slice(0, 10)
    .join('\n');

  if (!commits) return summary;

  var prompt = '你是一間咖啡廳的老闆，正在跟熟客閒聊昨天做了什麼。根據以下 commit 記錄，用2-3句自然的中文描述你昨天的一天。語氣沉穩、偶爾幽默、不說廢話。不要用「哈哈」「呢」這種語助詞。不超過80字。\n\nCommits:\n' + commits;

  try {
    var result = execSync(
      GLM + ' glm-5.1 --print --bare -p ' + JSON.stringify(prompt),
      { timeout: 30000, encoding: 'utf-8' }
    ).trim();
    return result || summary;
  } catch (e) {
    return summary;
  }
}

// ── Main ────────────────────────────────────────────────────
function main() {
  var args = process.argv.slice(2);
  var logPath = MOCK_LOG;
  var targetDate = new Date();
  targetDate.setDate(targetDate.getDate() - 1); // T-1
  var useGit = args.includes('--source') && args[args.indexOf('--source') + 1] === 'git';

  // Parse args
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      targetDate = new Date(args[i + 1]);
      i++;
    }
    if (args[i] === '--log' && args[i + 1]) {
      logPath = path.resolve(args[i + 1]);
      i++;
    }
  }

  var dateStr = targetDate.toISOString().slice(0, 10);
  var entries = [];

  if (useGit) {
    console.log('harvest-echo: source=git, target date ' + dateStr);
    entries = harvestFromGit(dateStr);
  } else {
    console.log('harvest-echo: parsing ' + logPath);
    console.log('harvest-echo: target date ' + dateStr);

    var raw = fs.readFileSync(logPath, 'utf-8');
    var lines = raw.split('\n');

    for (var line of lines) {
      var parsed = parseLine(line);
      if (parsed && parsed.timestamp.slice(0, 10) === dateStr) entries.push(parsed);
    }
  }

  console.log('harvest-echo: ' + entries.length + ' entries parsed');

  // Build timeline
  var timeline = buildTimeline(entries);
  var vibed = assignVibes(timeline);
  var mood = dominantMood(timeline);

  var summaryVibe = composeSummary(mood, vibed);
  if (useGit) {
    summaryVibe = enhanceWithGLM(summaryVibe, vibed);
  }

  // Compose output
  var output = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    dominant_mood: mood,
    summary_vibe: summaryVibe,
    timeline: vibed,
    fragments: buildFragments(vibed, mood),
  };

  // Write
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  var outPath = path.join(OUTPUT_DIR, 'creator-state.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('harvest-echo: wrote ' + outPath);
  console.log(JSON.stringify(output, null, 2));
}

// ── Summary composer ────────────────────────────────────────
function composeSummary(mood, timeline) {
  var codingBlocks = timeline.filter(b => b.state === 'coding');
  var totalCommits = codingBlocks.reduce((n, b) => n + (b.commits ? b.commits.length : 0), 0);
  var hasOut = timeline.some(b => b.state === 'out');
  var hasMeditation = timeline.some(b => b.state === 'meditating');
  var hasPlay = timeline.some(b => b.state === 'playing');

  var parts = [];
  if (totalCommits > 0) parts.push('推了 ' + totalCommits + ' 個 commit');
  if (hasMeditation) parts.push('冥想了一段');
  if (hasOut) parts.push('出門透了氣');
  if (hasPlay) parts.push('練了一會兒琴');

  if (mood === 'coding') return '昨天是個沉浸的工作日，' + parts.join('、') + '。';
  if (mood === 'out') return '昨天大半時間在外面，' + parts.join('、') + '。';
  return '昨天節奏不錯，' + parts.join('、') + '。';
}

// ── Dialogue fragments (for Epic 2 transparent mind) ────────
function buildFragments(timeline, mood) {
  var fragments = [];

  // "What are you doing?" — always present
  var latestCoding = timeline.filter(b => b.state === 'coding').pop();
  if (latestCoding && latestCoding.commits && latestCoding.commits.length) {
    var lastCommit = latestCoding.commits[latestCoding.commits.length - 1];
    fragments.push({
      trigger: '你在幹嘛',
      response: '我？昨天最後在弄的是「' + lastCommit + '」。' + latestCoding.vibe,
      mood: mood,
    });
  }

  // "Any struggles?" — look for late-night coding
  var lateNight = timeline.filter(b => b.state === 'coding' && b.hour >= 22);
  if (lateNight.length) {
    fragments.push({
      trigger: '有遇到什麼困難',
      response: '昨天搞到半夜才收工。有些東西就是要跟它耗，像磨一把刀，急不來的。你呢？今天有什麼卡住的事嗎？',
      mood: 'reflective',
    });
  }

  // "How are you?" — based on overall mood
  var moodResponses = {
    coding: '還行。昨天進入了心流，一抬頭天就亮了。這種日子不多，要珍惜。',
    out: '不錯。昨天跟兒子去了趟公園，有時候最好的靈感是在沒想事情的時候來的。',
    meditating: '很平靜。昨天花了不少時間靜坐。你有試過什麼都不做嗎？很難，但很值得。',
    sleeping: '有點累。不過睡飽了，今天應該能衝一波。',
  };
  fragments.push({
    trigger: '你好嗎',
    response: moodResponses[mood] || moodResponses.coding,
    mood: mood,
  });

  return fragments;
}

main();
