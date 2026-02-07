#!/usr/bin/env node
/**
 * 戰情儀表板 v0.2 — 多語場監控
 *
 * 數據源：Time Tunnel SQLite（跨頻道：Telegram / LINE / Discord）
 * 用法：
 *   node warroom-dashboard.js                  # text 輸出
 *   node warroom-dashboard.js --json           # JSON 輸出
 *   node warroom-dashboard.js --update         # 回寫到 Telegram pin message
 *   node warroom-dashboard.js --config=path    # 自訂配置路徑
 */

import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { getChatMessages, getAgentFieldPresence } from "../hooks/time-tunnel/query.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, "../data/warroom_dashboard_config.json");
const HOOKS_CONFIG = path.join(__dirname, "../hooks/config.json");

// ---------------------------------------------------------------------------
// 配置讀取
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw).warroom_dashboard;
}

function loadHooksConfig() {
  try {
    return JSON.parse(fs.readFileSync(HOOKS_CONFIG, "utf-8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// 分析模組
// ---------------------------------------------------------------------------

/**
 * 語場活動分析
 */
function analyzeChatActivity(messages) {
  if (!messages || messages.length === 0) {
    return { error: "無消息數據" };
  }

  const totalMessages = messages.length;
  const senders = new Map();
  let totalLength = 0;
  let earliest = messages[0].timestamp;
  let latest = messages[0].timestamp;

  for (const msg of messages) {
    const name = msg.sender_name || msg.sender_id || "Unknown";
    senders.set(name, (senders.get(name) || 0) + 1);
    totalLength += (msg.content || "").length;
    if (msg.timestamp < earliest) earliest = msg.timestamp;
    if (msg.timestamp > latest) latest = msg.timestamp;
  }

  const topSenders = [...senders.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({
      name,
      count,
      percentage: Math.round((count / totalMessages) * 100),
    }));

  return {
    totalMessages,
    uniqueSenders: senders.size,
    timeRange: { earliest, latest },
    topSenders,
    avgMessageLength: Math.round(totalLength / totalMessages),
  };
}

/**
 * 代理人軌跡分析
 */
function analyzeAgentActivity(messages, agentId, agentName) {
  const agentMessages = messages.filter(
    (msg) => msg.direction === "outbound" || msg.sender_id === agentId,
  );

  if (agentMessages.length === 0) {
    return { error: `代理人 ${agentName || agentId} 無發言記錄` };
  }

  const total = agentMessages.length;
  const percentage = Math.round((total / messages.length) * 100);

  const types = { command: 0, question: 0, long_form: 0, short: 0, regular: 0 };
  for (const msg of agentMessages) {
    const text = msg.content || "";
    if (text.startsWith("/")) types.command++;
    else if (/[?？]/.test(text) || /嗎|什麼|如何|怎麼|為什麼/.test(text)) types.question++;
    else if (text.length > 100) types.long_form++;
    else if (text.length < 20) types.short++;
    else types.regular++;
  }

  const replyTargets = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.direction === "outbound" || msg.sender_id === agentId) {
      for (let j = i + 1; j < Math.min(i + 4, messages.length); j++) {
        const next = messages[j];
        if (next.direction !== "outbound" && next.sender_id !== agentId) {
          const name = next.sender_name || next.sender_id || "Unknown";
          replyTargets.set(name, (replyTargets.get(name) || 0) + 1);
          break;
        }
      }
    }
  }

  const topReplyTargets = [...replyTargets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  const recentMessages = agentMessages.slice(-3).map((msg) => ({
    id: msg.id,
    text: (msg.content || "").slice(0, 50) + ((msg.content || "").length > 50 ? "..." : ""),
  }));

  return {
    agentName: agentName || agentId,
    totalMessages: total,
    percentageOfChat: percentage,
    messageTypes: types,
    topReplyTargets,
    recentMessages,
  };
}

/**
 * 轉折點偵測
 */
function detectTurningPoints(messages) {
  const decisionKeywords = [
    "好",
    "行",
    "同意",
    "確定",
    "開工",
    "開始",
    "就這樣",
    "決定",
    "OK",
    "ok",
  ];
  const questionKeywords = ["?", "？", "嗎", "什麼", "如何", "怎麼", "為什麼"];

  const points = [];

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    const prevSender = prev.sender_name || prev.sender_id;
    const currSender = curr.sender_name || curr.sender_id;
    const currText = curr.content || "";
    const prevText = prev.content || "";

    if (prevSender !== currSender && prevSender && currSender) {
      if (decisionKeywords.some((k) => currText.includes(k))) {
        points.push({
          type: "decision",
          messageId: curr.id,
          sender: currSender,
          text: currText.slice(0, 100),
        });
      } else if (questionKeywords.some((k) => currText.includes(k))) {
        points.push({
          type: "question",
          messageId: curr.id,
          sender: currSender,
          text: currText.slice(0, 100),
        });
      }
    }

    if (prevText.length < 50 && currText.length > 150) {
      points.push({
        type: "deep_dive",
        messageId: curr.id,
        sender: currSender,
        text: currText.slice(0, 100),
      });
    }
  }

  return points.slice(-5);
}

// ---------------------------------------------------------------------------
// 跨語場關聯分析
// ---------------------------------------------------------------------------

// 中文停用詞（2-gram 和 3-gram 都會用到）
const ZH_STOP_WORDS = new Set([
  "的",
  "了",
  "是",
  "在",
  "我",
  "有",
  "和",
  "就",
  "不",
  "人",
  "都",
  "一",
  "一個",
  "上",
  "也",
  "很",
  "到",
  "說",
  "要",
  "去",
  "你",
  "會",
  "着",
  "沒有",
  "看",
  "好",
  "自己",
  "這",
  "他",
  "她",
  "吧",
  "被",
  "比",
  "還",
  "那",
  "嗎",
  "可以",
  "什麼",
  "這個",
  "那個",
  "沒有",
  "可能",
  "已經",
  "應該",
  "因為",
  "所以",
  "但是",
  "如果",
  "知道",
  "覺得",
  "時候",
  "現在",
  "然後",
  "還是",
  "不是",
  "這樣",
  "那樣",
  "怎麼",
]);

const EN_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "and",
  "or",
  "but",
  "if",
  "while",
  "as",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "that",
  "this",
  "it",
  "not",
  "no",
  "yes",
  "http",
  "https",
  "www",
  "com",
]);

/**
 * 從消息中提取高頻關鍵詞
 * v0.2 改進：2-gram + 3-gram 混合，加去重和更完整的停用詞
 */
function extractKeywords(messages, topN = 20) {
  const freq = new Map();

  for (const msg of messages) {
    const text = (msg.content || "").toLowerCase();

    // 英文詞（3+ chars）
    const enWords = text.match(/[a-z]{3,}/g) || [];
    for (const w of enWords) {
      if (!EN_STOP_WORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }

    // 中文：提取連續漢字段，生成 2-gram 和 3-gram
    const zhSegments = text.match(/[\u4e00-\u9fff]+/g) || [];
    for (const seg of zhSegments) {
      // 2-gram
      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg.slice(i, i + 2);
        if (!ZH_STOP_WORDS.has(bigram)) freq.set(bigram, (freq.get(bigram) || 0) + 1);
      }
      // 3-gram（比 2-gram 更有意義的詞，如「思考者」「儀表板」）
      for (let i = 0; i < seg.length - 2; i++) {
        const trigram = seg.slice(i, i + 3);
        if (!ZH_STOP_WORDS.has(trigram)) freq.set(trigram, (freq.get(trigram) || 0) + 1);
      }
    }
  }

  // 去重：如果 3-gram "思考者" 和 2-gram "思考" 都在，且 3-gram 頻率 >= 2-gram 的 60%，
  // 優先保留 3-gram
  const candidates = [...freq.entries()].filter(([, count]) => count >= 2);
  const trigramSet = new Set();
  for (const [word] of candidates) {
    if (word.length === 3 && /[\u4e00-\u9fff]/.test(word)) trigramSet.add(word);
  }

  const filtered = candidates.filter(([word, count]) => {
    // 如果是 2-gram 且被某個高頻 3-gram 覆蓋，降權
    if (word.length === 2 && /[\u4e00-\u9fff]/.test(word)) {
      for (const tri of trigramSet) {
        if (tri.includes(word)) {
          const triCount = freq.get(tri) || 0;
          if (triCount >= count * 0.6) return false;
        }
      }
    }
    return true;
  });

  return filtered
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));
}

/**
 * 跨語場關聯分析
 */
function analyzeMultiField(chatResults) {
  if (chatResults.length < 2) {
    return { note: "需要至少 2 個語場才能進行關聯分析" };
  }

  // 1. 各語場關鍵詞
  const chatKeywords = chatResults.map((r) => ({
    chatName: r.chatConfig.name,
    keywords: extractKeywords(r.messages),
  }));

  // 2. 共同關鍵詞
  const keywordPresence = new Map();
  for (const ck of chatKeywords) {
    for (const { word } of ck.keywords) {
      if (!keywordPresence.has(word)) keywordPresence.set(word, new Set());
      keywordPresence.get(word).add(ck.chatName);
    }
  }
  const sharedKeywords = [...keywordPresence.entries()]
    .filter(([, chats]) => chats.size >= 2)
    .map(([word, chats]) => ({ word, chats: [...chats] }))
    .slice(0, 10);

  // 3. 能量節奏（每小時消息密度，UTC+8）
  const energyRhythm = chatResults.map((r) => {
    const hourBuckets = new Array(24).fill(0);
    for (const msg of r.messages) {
      try {
        const utcHour = new Date(msg.timestamp).getUTCHours();
        const tpeHour = (utcHour + 8) % 24;
        hourBuckets[tpeHour]++;
      } catch {
        // skip
      }
    }
    const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));
    return {
      chatName: r.chatConfig.name,
      totalMessages: r.messages.length,
      peakHourTPE: peakHour,
      hourDistribution: hourBuckets,
    };
  });

  // 4. 代理人跨語場軌跡
  const agentPresence = new Map();
  for (const r of chatResults) {
    for (const agent of r.chatConfig.agents || []) {
      if (!agentPresence.has(agent.id)) {
        agentPresence.set(agent.id, { name: agent.name, chats: [] });
      }
      const agentMsgs = r.messages.filter(
        (m) => m.direction === "outbound" || m.sender_id === agent.id,
      );
      agentPresence.get(agent.id).chats.push({
        chatName: r.chatConfig.name,
        messageCount: agentMsgs.length,
      });
    }
  }
  const crossFieldAgents = [...agentPresence.values()].filter((a) => a.chats.length >= 2);

  // 5. Session 域活動摘要
  const sessionSummary = new Map();
  for (const r of chatResults) {
    const session = r.chatConfig.session || "unknown";
    if (!sessionSummary.has(session)) sessionSummary.set(session, { totalMessages: 0, chats: 0 });
    const entry = sessionSummary.get(session);
    entry.totalMessages += r.messages.length;
    entry.chats += 1;
  }

  return {
    sharedKeywords,
    energyRhythm,
    crossFieldAgents,
    sessionSummary: [...sessionSummary.entries()].map(([session, data]) => ({
      session,
      ...data,
    })),
    chatKeywords: chatKeywords.map((ck) => ({
      chatName: ck.chatName,
      topKeywords: ck.keywords.slice(0, 10),
    })),
  };
}

// ---------------------------------------------------------------------------
// 輸出格式化
// ---------------------------------------------------------------------------

function formatTimestamp(isoStr) {
  try {
    const d = new Date(isoStr);
    const offset = 8 * 60 * 60 * 1000;
    const local = new Date(d.getTime() + offset);
    const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(local.getUTCDate()).padStart(2, "0");
    const hh = String(local.getUTCHours()).padStart(2, "0");
    const min = String(local.getUTCMinutes()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${min}`;
  } catch {
    return isoStr || "N/A";
  }
}

function formatTextDashboard(config, chatResults, multiFieldAnalysis) {
  const lines = [];
  const now = formatTimestamp(new Date().toISOString());

  lines.push(`${"=".repeat(50)}`);
  lines.push(`  戰情儀表板 v0.2 | ${now} TPE`);
  lines.push(`  監控語場: ${chatResults.length} 個`);
  lines.push(`${"=".repeat(50)}`);

  // Session 域摘要
  if (multiFieldAnalysis.sessionSummary) {
    lines.push("");
    lines.push("  域概覽:");
    for (const s of multiFieldAnalysis.sessionSummary) {
      lines.push(`    [${s.session}] ${s.chats} 群 / ${s.totalMessages} 條`);
    }
  }

  // 各語場分析
  for (const r of chatResults) {
    lines.push("");
    const session = r.chatConfig.session ? ` [${r.chatConfig.session}]` : "";
    lines.push(`--- ${r.chatConfig.name}${session} ---`);

    const act = r.activity;
    if (act.error) {
      lines.push(`  ${act.error}`);
      continue;
    }

    lines.push(
      `  ${act.totalMessages} 條 | ${act.uniqueSenders} 人 | 均長 ${act.avgMessageLength} 字`,
    );
    lines.push(
      `  ${formatTimestamp(act.timeRange.earliest)} ~ ${formatTimestamp(act.timeRange.latest)}`,
    );

    // Top 3 發言者（壓縮行數）
    const topLine = act.topSenders
      .slice(0, 3)
      .map((s) => `${s.name}(${s.count})`)
      .join(" ");
    lines.push(`  Top: ${topLine}`);

    // 代理人（壓縮）
    for (const agentResult of r.agentResults) {
      if (agentResult.error) continue;
      const threshold = config.agent_visibility_threshold || 30;
      const warning = agentResult.percentageOfChat > threshold ? " !" : "";
      lines.push(
        `  Bot: ${agentResult.totalMessages} 條 (${agentResult.percentageOfChat}%)${warning}`,
      );
    }

    // 轉折點（最多 2 個）
    const tps = r.turningPoints.slice(-2);
    if (tps.length > 0) {
      for (const tp of tps) {
        const icon = tp.type === "decision" ? ">" : tp.type === "question" ? "?" : "*";
        lines.push(`  ${icon} ${tp.sender}: ${tp.text.slice(0, 40)}`);
      }
    }
  }

  // 跨語場關聯
  if (multiFieldAnalysis && !multiFieldAnalysis.note) {
    lines.push("");
    lines.push(`${"=".repeat(50)}`);
    lines.push(`  跨語場關聯`);
    lines.push(`${"=".repeat(50)}`);

    if (multiFieldAnalysis.sharedKeywords.length > 0) {
      const kwLine = multiFieldAnalysis.sharedKeywords
        .slice(0, 5)
        .map((sk) => `${sk.word}(${sk.chats.length}群)`)
        .join(" ");
      lines.push(`  共同詞: ${kwLine}`);
    }

    if (multiFieldAnalysis.crossFieldAgents.length > 0) {
      for (const agent of multiFieldAnalysis.crossFieldAgents) {
        const presence = agent.chats.map((c) => `${c.chatName}(${c.messageCount})`).join(" ");
        lines.push(`  跨群: ${agent.name} -> ${presence}`);
      }
    }

    // 能量節奏（壓縮）
    const rhythm = multiFieldAnalysis.energyRhythm
      .map((er) => `${er.chatName}:${er.totalMessages}條@${er.peakHourTPE}h`)
      .join(" | ");
    lines.push(`  節奏: ${rhythm}`);
  }

  lines.push("");
  return lines.join("\n");
}

function formatJsonDashboard(config, chatResults, multiFieldAnalysis) {
  return JSON.stringify(
    {
      version: "0.2",
      generatedAt: new Date().toISOString(),
      monitoredChats: chatResults.length,
      chats: chatResults.map((r) => ({
        config: r.chatConfig,
        activity: r.activity,
        agents: r.agentResults,
        turningPoints: r.turningPoints,
      })),
      crossFieldAnalysis: multiFieldAnalysis,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Telegram 回寫
// ---------------------------------------------------------------------------

function telegramApiCall(token, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(buf);
            json.ok
              ? resolve(json.result)
              : reject(new Error(json.description || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function publishToTelegram(config, dashboardText, configPath) {
  const hooksConfig = loadHooksConfig();
  const token =
    process.env.DASHBOARD_BOT_TOKEN ||
    hooksConfig.telegram?.dashboardBot?.token ||
    hooksConfig.telegram?.logBot?.token;

  if (!token) {
    console.error(
      "[update] No Telegram bot token found (set DASHBOARD_BOT_TOKEN or hooks/config.json)",
    );
    return false;
  }

  const chatId = config.output?.chat_id;
  const messageId = config.output?.message_id;

  if (!chatId || !messageId) {
    console.error("[update] output.chat_id or output.message_id missing in config");
    return false;
  }

  // Telegram message 字數上限 4096
  const text = dashboardText.length > 4000 ? dashboardText.slice(0, 3990) + "\n..." : dashboardText;

  try {
    await telegramApiCall(token, "editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
    });
    console.log(`[update] Telegram pin message updated (chat=${chatId} msg=${messageId})`);

    // 更新 config 的 last_updated
    try {
      const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      rawConfig.warroom_dashboard.last_updated = new Date().toISOString();
      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + "\n", "utf-8");
    } catch {
      // non-critical
    }

    return true;
  } catch (err) {
    console.error(`[update] Failed to update Telegram: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function generateDashboard(configPath, { outputJson = false, update = false } = {}) {
  const config = loadConfig(configPath);
  const monitoredChats = config.monitored_chats || [];

  if (monitoredChats.length === 0) {
    console.log("No monitored chats configured.");
    return;
  }

  const chatResults = [];

  for (const chatConfig of monitoredChats) {
    const messages = getChatMessages(chatConfig.id, { limit: 500, minutesBack: 360 });
    const activity = analyzeChatActivity(messages);
    const turningPoints = detectTurningPoints(messages);

    const agentResults = (chatConfig.agents || []).map((agent) =>
      analyzeAgentActivity(messages, agent.id, agent.name),
    );

    chatResults.push({ chatConfig, messages, activity, agentResults, turningPoints });
  }

  const multiFieldAnalysis = analyzeMultiField(chatResults);

  if (outputJson) {
    console.log(formatJsonDashboard(config, chatResults, multiFieldAnalysis));
  } else {
    const text = formatTextDashboard(config, chatResults, multiFieldAnalysis);
    console.log(text);

    if (update) {
      return publishToTelegram(config, text, configPath);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const updateFlag = args.includes("--update");
const configArg = args.find((a) => a.startsWith("--config="));
const configPath = configArg ? configArg.split("=")[1] : DEFAULT_CONFIG;

try {
  await generateDashboard(configPath, { outputJson: jsonFlag, update: updateFlag });
} catch (err) {
  console.error("Dashboard error:", err.message);
  process.exit(1);
}
