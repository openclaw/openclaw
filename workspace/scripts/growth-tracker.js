#!/usr/bin/env node
/**
 * 成長指標追蹤 — 每次跑完存入 data/growth-metrics.json
 *
 * Migrated from growth_tracker.py → JS (統一語言)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOME = process.env.HOME || "/root";
const CLAWD = join(HOME, "clawd");
const METRICS_FILE = join(CLAWD, "data", "growth-metrics.json");

function run(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function loadMetrics() {
  try {
    return JSON.parse(readFileSync(METRICS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function collectToday() {
  const today = new Date().toISOString().slice(0, 10);

  // Skills
  const skillsDir = join(CLAWD, "skills");
  let totalSkills = 0;
  let modifiedToday = 0;
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      totalSkills++;
      const mt = statSync(join(skillsDir, e.name)).mtime;
      if (mt.toISOString().slice(0, 10) === today) modifiedToday++;
    }
  } catch {}

  // Memory — daily lines
  const todayFile = join(CLAWD, "memory", `${today}.md`);
  let dailyLines = 0;
  try {
    dailyLines = readFileSync(todayFile, "utf-8").split("\n").length;
  } catch {}

  // Commits today
  const commitsToday =
    Number(run(`cd ${CLAWD} && git log --oneline --since='midnight' 2>/dev/null | wc -l`)) || 0;

  // Calibrations
  const calDir = join(HOME, "Documents/幣塔/data/calibrations");
  let calToday = 0;
  let calTotal = 0;
  try {
    for (const f of readdirSync(calDir)) {
      calTotal++;
      if (f.includes(today)) calToday++;
    }
  } catch {}

  // Corrections（從今日 memory 找糾正記錄）
  let correctionsToday = 0;
  try {
    const content = readFileSync(todayFile, "utf-8");
    correctionsToday = (content.match(/糾正|correction|⚠️ 錯誤/g) || []).length;
  } catch {}

  return {
    date: today,
    skills: { total: totalSkills, modified: modifiedToday },
    memory: { daily_lines: dailyLines, commits_today: commitsToday },
    calibrations: { today: calToday, total: calTotal },
    corrections: { today: correctionsToday },
  };
}

function main() {
  let metrics = loadMetrics();
  const todayData = collectToday();
  const today = todayData.date;

  // 更新或新增今日記錄
  const idx = metrics.findIndex((m) => m.date === today);
  if (idx >= 0) metrics[idx] = todayData;
  else metrics.push(todayData);

  // 只保留最近 90 天
  metrics = metrics.slice(-90);

  mkdirSync(resolve(METRICS_FILE, ".."), { recursive: true });
  writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2) + "\n", "utf-8");

  console.log(`📈 成長指標已更新: ${today}`);
  console.log(`   Skills: ${todayData.skills.total}個 | Memory: ${todayData.memory.daily_lines}行`);
  console.log(
    `   Commits: ${todayData.memory.commits_today} | 校準: ${todayData.calibrations.today}筆`,
  );
}

main();
