#!/usr/bin/env node
/**
 * 戰情儀表板 v0.2 — 多語場監控
 *
 * 數據源：Time Tunnel SQLite（跨頻道：Telegram / LINE / Discord）
 * 用法：node warroom-dashboard.js [--json] [--config=path]
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getChatMessages, getAgentFieldPresence } from "../hooks/time-tunnel/query.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, "../data/warroom_dashboard_config.json");

// ---------------------------------------------------------------------------
// 配置讀取
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw).warroom_dashboard;
}

// ---------------------------------------------------------------------------
// 分析模組（從 Python v0.1 移植 + 增強）
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

  // Top 5 發言者
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
  // 代理人的消息 = outbound 方向（bot 發出的）
  const agentMessages = messages.filter(
    (msg) => msg.direction === "outbound" || msg.sender_id === agentId,
  );

  if (agentMessages.length === 0) {
    return { error: `代理人 ${agentName || agentId} 無發言記錄` };
  }

  const total = agentMessages.length;
  const percentage = Math.round((total / messages.length) * 100);

  // 消息類型分類
  const types = { command: 0, question: 0, long_form: 0, short: 0, regular: 0 };
  for (const msg of agentMessages) {
    const text = msg.content || "";
    if (text.startsWith("/")) types.command++;
    else if (/[?？]/.test(text) || /嗎|什麼|如何|怎麼|為什麼/.test(text)) types.question++;
    else if (text.length > 100) types.long_form++;
    else if (text.length < 20) types.short++;
    else types.regular++;
  }

  // 互動對象（代理人發言後，誰接著回覆）
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

  // 最近 3 條消息
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

    // 發送者切換
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

    // 消息長度突變（短→長 = 深入討論）
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
// v0.2 新增：跨語場關聯分析
// ---------------------------------------------------------------------------

/**
 * 從消息中提取高頻關鍵詞（簡易版：中文斷詞 by 字元 n-gram + 英文空格切詞）
 */
function extractKeywords(messages, topN = 20) {
  const stopWords = new Set([
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
  ]);

  const freq = new Map();

  for (const msg of messages) {
    const text = (msg.content || "").toLowerCase();
    // 英文詞
    const enWords = text.match(/[a-z]{3,}/g) || [];
    for (const w of enWords) {
      if (!stopWords.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
    // 中文 2-gram
    const zhChars = text.match(/[\u4e00-\u9fff]+/g) || [];
    for (const segment of zhChars) {
      for (let i = 0; i < segment.length - 1; i++) {
        const bigram = segment.slice(i, i + 2);
        if (!stopWords.has(bigram)) freq.set(bigram, (freq.get(bigram) || 0) + 1);
      }
    }
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));
}

/**
 * 跨語場關聯分析
 * @param {Array<{chatConfig: object, messages: Array, activity: object}>} chatResults
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

  // 2. 共同關鍵詞（出現在 >= 2 個語場的詞）
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

  // 3. 能量節奏對比（每小時消息密度）
  const energyRhythm = chatResults.map((r) => {
    const hourBuckets = new Array(24).fill(0);
    for (const msg of r.messages) {
      try {
        const hour = new Date(msg.timestamp).getUTCHours();
        hourBuckets[hour]++;
      } catch {
        // skip invalid timestamps
      }
    }
    const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));
    return {
      chatName: r.chatConfig.name,
      totalMessages: r.messages.length,
      peakHourUTC: peakHour,
      hourDistribution: hourBuckets,
    };
  });

  // 4. 代理人跨語場軌跡（哪些 agent 出現在多個語場）
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

  return {
    sharedKeywords,
    energyRhythm,
    crossFieldAgents,
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
    // UTC+8
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
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  lines.push(`${"=".repeat(60)}`);
  lines.push(`  戰情儀表板 v0.2 | ${now} UTC`);
  lines.push(`  監控語場: ${chatResults.length} 個`);
  lines.push(`${"=".repeat(60)}`);

  // 各語場分析
  for (const r of chatResults) {
    lines.push("");
    lines.push(`--- ${r.chatConfig.name} (${r.chatConfig.channel}) ---`);

    const act = r.activity;
    if (act.error) {
      lines.push(`  ${act.error}`);
      continue;
    }

    lines.push(`  消息數: ${act.totalMessages} | 參與者: ${act.uniqueSenders}`);
    lines.push(
      `  時間: ${formatTimestamp(act.timeRange.earliest)} ~ ${formatTimestamp(act.timeRange.latest)}`,
    );
    lines.push(`  平均長度: ${act.avgMessageLength} 字元`);
    lines.push(`  Top 發言者:`);
    for (const s of act.topSenders) {
      lines.push(`    ${s.name}: ${s.count} 條 (${s.percentage}%)`);
    }

    // 代理人分析
    for (const agentResult of r.agentResults) {
      if (agentResult.error) {
        lines.push(`  代理人: ${agentResult.error}`);
        continue;
      }
      const threshold = config.agent_visibility_threshold || 30;
      const warning = agentResult.percentageOfChat > threshold ? " [!超標]" : "";
      lines.push(
        `  代理人 ${agentResult.agentName}: ${agentResult.totalMessages} 條 (${agentResult.percentageOfChat}%)${warning}`,
      );

      if (agentResult.recentMessages.length > 0) {
        lines.push(`  最近發言:`);
        for (const m of agentResult.recentMessages) {
          lines.push(`    [${m.id}] ${m.text}`);
        }
      }
    }

    // 轉折點
    if (r.turningPoints.length > 0) {
      lines.push(`  轉折點:`);
      for (const tp of r.turningPoints) {
        const icon =
          tp.type === "decision" ? "[決策]" : tp.type === "question" ? "[提問]" : "[深入]";
        lines.push(`    ${icon} ${tp.sender}: ${tp.text}`);
      }
    }
  }

  // 跨語場關聯
  if (multiFieldAnalysis && !multiFieldAnalysis.note) {
    lines.push("");
    lines.push(`${"=".repeat(60)}`);
    lines.push(`  跨語場關聯分析`);
    lines.push(`${"=".repeat(60)}`);

    if (multiFieldAnalysis.sharedKeywords.length > 0) {
      lines.push(`  共同關鍵詞:`);
      for (const sk of multiFieldAnalysis.sharedKeywords) {
        lines.push(`    「${sk.word}」 出現在: ${sk.chats.join(", ")}`);
      }
    }

    if (multiFieldAnalysis.crossFieldAgents.length > 0) {
      lines.push(`  跨語場代理人:`);
      for (const agent of multiFieldAnalysis.crossFieldAgents) {
        const presence = agent.chats.map((c) => `${c.chatName}(${c.messageCount})`).join(", ");
        lines.push(`    ${agent.name}: ${presence}`);
      }
    }

    lines.push(`  能量節奏:`);
    for (const er of multiFieldAnalysis.energyRhythm) {
      lines.push(`    ${er.chatName}: ${er.totalMessages} 條, 高峰 UTC${er.peakHourUTC}時`);
    }
  }

  lines.push("");
  lines.push(`${"=".repeat(60)}`);
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
// 主入口
// ---------------------------------------------------------------------------

function generateDashboard(configPath, outputJson = false) {
  const config = loadConfig(configPath);
  const monitoredChats = config.monitored_chats || [];

  if (monitoredChats.length === 0) {
    console.log("No monitored chats configured.");
    return;
  }

  const chatResults = [];

  for (const chatConfig of monitoredChats) {
    const messages = getChatMessages(chatConfig.id, { limit: 100, minutesBack: 120 });
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
    console.log(formatTextDashboard(config, chatResults, multiFieldAnalysis));
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonFlag = args.includes("--json");
const configArg = args.find((a) => a.startsWith("--config="));
const configPath = configArg ? configArg.split("=")[1] : DEFAULT_CONFIG;

try {
  generateDashboard(configPath, jsonFlag);
} catch (err) {
  console.error("Dashboard error:", err.message);
  process.exit(1);
}
