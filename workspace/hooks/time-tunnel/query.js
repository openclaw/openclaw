// Time Tunnel 查詢 API - Level 103 內省記錄級
//
// Level 30: 全文搜索、時間線查詢、對話樹、統計分析
// Level 40: 互動關係、時間回溯、匯出
// Level 50: 主題提取、每日摘要、語義搜索
// Level 60: 情感分析、跨身份追蹤、對話脈絡圖
// Level 70: 向量嵌入搜索、預測性回憶、自我反思報告
// Level 80: 真正向量嵌入、長期記憶強化、自主學習
// Level 90: 自動記憶整合、跨會話知識庫、主動提醒系統
// Level 100: 自動觸發整合、主動學習循環、情境感知回應
// Level 101: AI 報酬感知系統（數據、權限、存在感三維度）
// Level 102: 對話脈絡判斷（LLM 語義判斷是否需要回應）
// Level 103: 內省記錄（三思而後行 - 記錄思考過程，形成遞歸意識）
// Level 104: sqlite-vec 向量搜索（真正的語義相似度匹配）

import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
// 向量搜索模組（sqlite-vec 整合）
import * as vecModule from "./vector-search.js";

// 數據目錄邏輯（與 handler.js 一致）
const DATA_ROOT = "/app/persistent/data";
const FALLBACK_DATA_DIR = "/app/workspace/data";
const DATA_DIR = fs.existsSync(DATA_ROOT) ? DATA_ROOT : FALLBACK_DATA_DIR;
const DB_PATH = path.join(DATA_DIR, "timeline.db");
console.log(`[time-tunnel/query] 📂 Data directory: ${DATA_DIR}`);

let db = null;
let vecInitialized = false;

function getDb() {
  if (db) return db;
  // 啟用擴展載入以支援 sqlite-vec
  // 注意：node:sqlite 需要 allowExtension: true，然後再 enableLoadExtension(true)
  db = new DatabaseSync(DB_PATH, { allowExtension: true });
  db.enableLoadExtension(true);

  // 嘗試初始化向量搜索
  if (!vecInitialized) {
    try {
      vecInitialized = vecModule.initVectorSearch(db);
    } catch (err) {
      console.warn("[time-tunnel] Vector search not available:", err.message);
    }
  }

  return db;
}

// =============================================================================
// 全文搜索
// =============================================================================

/**
 * 全文搜索消息
 * @param {string} query - 搜索關鍵字
 * @param {Object} options - 搜索選項
 * @param {string} options.project - 限定項目
 * @param {string} options.person - 限定人員
 * @param {string} options.startDate - 開始日期 (YYYY-MM-DD)
 * @param {string} options.endDate - 結束日期 (YYYY-MM-DD)
 * @param {number} options.limit - 限制數量 (預設 50)
 * @returns {Array} 搜索結果
 */
export function search(query, options = {}) {
  const database = getDb();
  const { project, person, startDate, endDate, limit = 50 } = options;

  // 構建 FTS5 查詢
  let sql = `
    SELECT
      m.id,
      m.timestamp,
      m.direction,
      m.channel,
      m.resolved_chat_name as chat,
      m.resolved_sender_name as sender,
      m.resolved_project as project,
      m.content,
      m.message_id,
      m.reply_to_id,
      highlight(messages_fts, 0, '【', '】') as highlight
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    WHERE messages_fts MATCH ?
  `;

  const params = [query];

  if (project) {
    sql += ` AND m.resolved_project = ?`;
    params.push(project);
  }

  if (person) {
    sql += ` AND m.resolved_sender_name LIKE ?`;
    params.push(`%${person}%`);
  }

  if (startDate) {
    sql += ` AND m.timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    sql += ` AND m.timestamp <= ?`;
    params.push(endDate + "T23:59:59");
  }

  sql += ` ORDER BY m.timestamp DESC LIMIT ?`;
  params.push(limit);

  try {
    const stmt = database.prepare(sql);
    return stmt.all(...params);
  } catch (err) {
    console.error("[time-tunnel] Search error:", err.message);
    return [];
  }
}

// =============================================================================
// 時間線查詢
// =============================================================================

/**
 * 查詢時間線
 * @param {Object} options - 查詢選項
 * @param {string} options.project - 限定項目
 * @param {string} options.chat - 限定聊天室
 * @param {string} options.person - 限定人員
 * @param {string} options.startDate - 開始日期
 * @param {string} options.endDate - 結束日期
 * @param {string} options.direction - 'inbound' | 'outbound' | 'all'
 * @param {number} options.limit - 限制數量
 * @param {number} options.offset - 偏移量
 * @returns {Array} 消息列表
 */
export function timeline(options = {}) {
  const database = getDb();
  const { project, chat, person, startDate, endDate, direction, limit = 100, offset = 0 } = options;

  let sql = `
    SELECT
      id,
      timestamp,
      direction,
      channel,
      chat_id,
      resolved_chat_name as chat,
      resolved_sender_name as sender,
      resolved_project as project,
      content,
      media_type,
      message_id,
      reply_to_id
    FROM messages
    WHERE 1=1
  `;

  const params = [];

  if (project) {
    sql += ` AND resolved_project = ?`;
    params.push(project);
  }

  if (chat) {
    sql += ` AND (resolved_chat_name LIKE ? OR chat_id = ?)`;
    params.push(`%${chat}%`, chat);
  }

  if (person) {
    sql += ` AND resolved_sender_name LIKE ?`;
    params.push(`%${person}%`);
  }

  if (startDate) {
    sql += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    sql += ` AND timestamp <= ?`;
    params.push(endDate + "T23:59:59");
  }

  if (direction && direction !== "all") {
    sql += ` AND direction = ?`;
    params.push(direction);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const stmt = database.prepare(sql);
    return stmt.all(...params);
  } catch (err) {
    console.error("[time-tunnel] Timeline error:", err.message);
    return [];
  }
}

// =============================================================================
// 對話樹查詢
// =============================================================================

/**
 * 獲取對話樹（一個消息的所有回覆鏈）
 * @param {string} messageId - 起始消息 ID
 * @param {string} chatId - 聊天室 ID
 * @returns {Object} 對話樹結構
 */
export function getConversationThread(messageId, chatId) {
  const database = getDb();

  // 向上追溯：找到這條消息回覆的消息
  function getParents(msgId, depth = 0) {
    if (depth > 20) return []; // 防止無限循環

    const msg = database
      .prepare(
        `
      SELECT
        id, timestamp, direction, resolved_sender_name as sender,
        resolved_chat_name as chat, content, message_id, reply_to_id
      FROM messages
      WHERE message_id = ? AND chat_id = ?
    `,
      )
      .get(msgId, chatId);

    if (!msg) return [];

    const parents = msg.reply_to_id ? getParents(msg.reply_to_id, depth + 1) : [];
    return [...parents, msg];
  }

  // 向下追溯：找到所有回覆這條消息的消息
  function getReplies(msgId, depth = 0) {
    if (depth > 10) return []; // 限制深度

    const replies = database
      .prepare(
        `
      SELECT
        id, timestamp, direction, resolved_sender_name as sender,
        resolved_chat_name as chat, content, message_id, reply_to_id
      FROM messages
      WHERE reply_to_id = ? AND chat_id = ?
      ORDER BY timestamp ASC
    `,
      )
      .all(msgId, chatId);

    return replies.map((r) => ({
      ...r,
      replies: getReplies(r.message_id, depth + 1),
    }));
  }

  // 獲取主消息
  const mainMessage = database
    .prepare(
      `
    SELECT
      id, timestamp, direction, resolved_sender_name as sender,
      resolved_chat_name as chat, content, message_id, reply_to_id
    FROM messages
    WHERE message_id = ? AND chat_id = ?
  `,
    )
    .get(messageId, chatId);

  if (!mainMessage) {
    return null;
  }

  return {
    ancestors: mainMessage.reply_to_id ? getParents(mainMessage.reply_to_id) : [],
    message: mainMessage,
    replies: getReplies(messageId),
  };
}

/**
 * 獲取最近的對話（按時間分組）
 * @param {string} chatId - 聊天室 ID
 * @param {number} windowMinutes - 時間窗口（分鐘）
 * @param {number} limit - 限制數量
 * @returns {Array} 對話組
 */
export function getRecentConversations(chatId, windowMinutes = 30, limit = 10) {
  const database = getDb();

  const messages = database
    .prepare(
      `
    SELECT
      id, timestamp, direction, resolved_sender_name as sender,
      content, message_id, reply_to_id
    FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT 500
  `,
    )
    .all(chatId);

  // 按時間窗口分組
  const conversations = [];
  let currentGroup = [];
  let lastTime = null;

  for (const msg of messages.reverse()) {
    const msgTime = new Date(msg.timestamp).getTime();

    if (lastTime && msgTime - lastTime > windowMinutes * 60 * 1000) {
      if (currentGroup.length > 0) {
        conversations.push(currentGroup);
      }
      currentGroup = [];
    }

    currentGroup.push(msg);
    lastTime = msgTime;
  }

  if (currentGroup.length > 0) {
    conversations.push(currentGroup);
  }

  return conversations.slice(-limit).reverse();
}

// =============================================================================
// 統計分析
// =============================================================================

/**
 * 獲取統計資料
 * @param {Object} options - 查詢選項
 * @returns {Object} 統計結果
 */
export function getStats(options = {}) {
  const database = getDb();
  const { startDate, endDate } = options;

  let dateFilter = "";
  const params = [];

  if (startDate) {
    dateFilter += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    dateFilter += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 總消息數
  const total = database
    .prepare(`SELECT COUNT(*) as count FROM messages WHERE 1=1 ${dateFilter}`)
    .get(...params);

  // 按項目統計
  const byProject = database
    .prepare(
      `
    SELECT resolved_project as project, COUNT(*) as count
    FROM messages
    WHERE resolved_project IS NOT NULL ${dateFilter}
    GROUP BY resolved_project
    ORDER BY count DESC
  `,
    )
    .all(...params);

  // 按人員統計
  const byPerson = database
    .prepare(
      `
    SELECT resolved_sender_name as person, COUNT(*) as count
    FROM messages
    WHERE resolved_sender_name IS NOT NULL ${dateFilter}
    GROUP BY resolved_sender_name
    ORDER BY count DESC
    LIMIT 20
  `,
    )
    .all(...params);

  // 按聊天室統計
  const byChat = database
    .prepare(
      `
    SELECT resolved_chat_name as chat, COUNT(*) as count
    FROM messages
    WHERE resolved_chat_name IS NOT NULL ${dateFilter}
    GROUP BY resolved_chat_name
    ORDER BY count DESC
    LIMIT 20
  `,
    )
    .all(...params);

  // 按日期統計
  const byDate = database
    .prepare(
      `
    SELECT DATE(timestamp) as date, COUNT(*) as count
    FROM messages
    WHERE 1=1 ${dateFilter}
    GROUP BY DATE(timestamp)
    ORDER BY date DESC
    LIMIT 30
  `,
    )
    .all(...params);

  // 方向統計
  const byDirection = database
    .prepare(
      `
    SELECT direction, COUNT(*) as count
    FROM messages
    WHERE 1=1 ${dateFilter}
    GROUP BY direction
  `,
    )
    .all(...params);

  return {
    total: total.count,
    byProject,
    byPerson,
    byChat,
    byDate,
    byDirection,
  };
}

// =============================================================================
// Level 40: 互動關係分析
// =============================================================================

/**
 * 分析人員之間的互動關係
 * @param {Object} options - 查詢選項
 * @returns {Object} 關係網絡數據
 */
export function getRelationships(options = {}) {
  const database = getDb();
  const { project, chat, limit = 20 } = options;

  let whereClause = "WHERE 1=1";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (chat) {
    whereClause += " AND resolved_chat_name LIKE ?";
    params.push(`%${chat}%`);
  }

  // 互動頻率：同一聊天室中，誰回覆誰最多
  const replyRelations = database
    .prepare(
      `
    SELECT
      m1.resolved_sender_name as from_person,
      m2.resolved_sender_name as to_person,
      COUNT(*) as reply_count
    FROM messages m1
    JOIN messages m2 ON m1.reply_to_id = m2.message_id AND m1.chat_id = m2.chat_id
    ${whereClause}
      AND m1.resolved_sender_name IS NOT NULL
      AND m2.resolved_sender_name IS NOT NULL
      AND m1.resolved_sender_name != m2.resolved_sender_name
    GROUP BY m1.resolved_sender_name, m2.resolved_sender_name
    ORDER BY reply_count DESC
    LIMIT ?
  `,
    )
    .all(...params, limit);

  // 同聊天室活躍度：誰和誰經常在同一個聊天室出現
  const coPresence = database
    .prepare(
      `
    SELECT
      p1.person as person1,
      p2.person as person2,
      COUNT(DISTINCT p1.chat_id) as shared_chats,
      SUM(p1.msg_count + p2.msg_count) as total_messages
    FROM (
      SELECT resolved_sender_name as person, chat_id, COUNT(*) as msg_count
      FROM messages
      ${whereClause} AND resolved_sender_name IS NOT NULL
      GROUP BY resolved_sender_name, chat_id
    ) p1
    JOIN (
      SELECT resolved_sender_name as person, chat_id, COUNT(*) as msg_count
      FROM messages
      ${whereClause} AND resolved_sender_name IS NOT NULL
      GROUP BY resolved_sender_name, chat_id
    ) p2 ON p1.chat_id = p2.chat_id AND p1.person < p2.person
    GROUP BY p1.person, p2.person
    ORDER BY shared_chats DESC, total_messages DESC
    LIMIT ?
  `,
    )
    .all(...params, ...params, limit);

  // 活躍時段分析
  const activityByHour = database
    .prepare(
      `
    SELECT
      CAST(strftime('%H', timestamp) AS INTEGER) as hour,
      resolved_sender_name as person,
      COUNT(*) as count
    FROM messages
    ${whereClause} AND resolved_sender_name IS NOT NULL
    GROUP BY hour, resolved_sender_name
    ORDER BY count DESC
    LIMIT 50
  `,
    )
    .all(...params);

  // 回覆速度（平均回覆時間）
  const responseTime = database
    .prepare(
      `
    SELECT
      m2.resolved_sender_name as responder,
      AVG(
        (julianday(m1.timestamp) - julianday(m2.timestamp)) * 24 * 60
      ) as avg_response_minutes,
      COUNT(*) as response_count
    FROM messages m1
    JOIN messages m2 ON m1.reply_to_id = m2.message_id AND m1.chat_id = m2.chat_id
    ${whereClause}
      AND m1.resolved_sender_name IS NOT NULL
      AND m2.resolved_sender_name IS NOT NULL
    GROUP BY m2.resolved_sender_name
    HAVING response_count >= 3
    ORDER BY avg_response_minutes ASC
    LIMIT ?
  `,
    )
    .all(...params, limit);

  return {
    replyRelations,
    coPresence,
    activityByHour,
    responseTime,
  };
}

// =============================================================================
// Level 40: 時間回溯
// =============================================================================

/**
 * 查詢歷史上的今天
 * @param {Object} options - 查詢選項
 * @returns {Object} 歷史對比數據
 */
export function getThisDayInHistory(options = {}) {
  const database = getDb();
  const { project, person, yearsBack = 1 } = options;

  const today = new Date();
  const monthDay = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  let whereClause = "WHERE strftime('%m-%d', timestamp) = ?";
  const params = [monthDay];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (person) {
    whereClause += " AND resolved_sender_name LIKE ?";
    params.push(`%${person}%`);
  }

  // 歷史上的今天的消息
  const historicalMessages = database
    .prepare(
      `
    SELECT
      DATE(timestamp) as date,
      strftime('%Y', timestamp) as year,
      resolved_chat_name as chat,
      resolved_sender_name as sender,
      resolved_project as project,
      content,
      direction
    FROM messages
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT 100
  `,
    )
    .all(...params);

  // 按年份分組
  const byYear = {};
  for (const msg of historicalMessages) {
    if (!byYear[msg.year]) {
      byYear[msg.year] = [];
    }
    byYear[msg.year].push(msg);
  }

  // 統計每年今天的活動量
  const yearlyActivity = database
    .prepare(
      `
    SELECT
      strftime('%Y', timestamp) as year,
      COUNT(*) as message_count,
      COUNT(DISTINCT resolved_sender_name) as unique_senders,
      COUNT(DISTINCT resolved_chat_name) as unique_chats
    FROM messages
    ${whereClause}
    GROUP BY year
    ORDER BY year DESC
  `,
    )
    .all(...params);

  return {
    date: monthDay,
    byYear,
    yearlyActivity,
  };
}

/**
 * 對比兩個時間段
 * @param {string} period1Start - 第一個時間段開始
 * @param {string} period1End - 第一個時間段結束
 * @param {string} period2Start - 第二個時間段開始
 * @param {string} period2End - 第二個時間段結束
 * @returns {Object} 對比結果
 */
export function comparePeriods(period1Start, period1End, period2Start, period2End) {
  const database = getDb();

  const getStats = (start, end) => {
    return database
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        COUNT(DISTINCT resolved_sender_name) as unique_senders,
        COUNT(DISTINCT resolved_chat_name) as unique_chats,
        COUNT(DISTINCT resolved_project) as unique_projects,
        SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound
      FROM messages
      WHERE timestamp >= ? AND timestamp <= ?
    `,
      )
      .get(start, end + "T23:59:59");
  };

  const period1 = getStats(period1Start, period1End);
  const period2 = getStats(period2Start, period2End);

  return {
    period1: { range: `${period1Start} ~ ${period1End}`, ...period1 },
    period2: { range: `${period2Start} ~ ${period2End}`, ...period2 },
    diff: {
      total: period2.total - period1.total,
      unique_senders: period2.unique_senders - period1.unique_senders,
      unique_chats: period2.unique_chats - period1.unique_chats,
    },
  };
}

// =============================================================================
// Level 40: 匯出功能
// =============================================================================

/**
 * 匯出數據
 * @param {Object} options - 匯出選項
 * @returns {string} 匯出的數據
 */
export function exportData(options = {}) {
  const database = getDb();
  const { format = "json", project, chat, person, startDate, endDate, limit = 1000 } = options;

  let whereClause = "WHERE 1=1";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (chat) {
    whereClause += " AND resolved_chat_name LIKE ?";
    params.push(`%${chat}%`);
  }
  if (person) {
    whereClause += " AND resolved_sender_name LIKE ?";
    params.push(`%${person}%`);
  }
  if (startDate) {
    whereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    whereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  const messages = database
    .prepare(
      `
    SELECT
      timestamp,
      direction,
      channel,
      resolved_chat_name as chat,
      resolved_sender_name as sender,
      resolved_project as project,
      content,
      media_type,
      message_id,
      reply_to_id
    FROM messages
    ${whereClause}
    ORDER BY timestamp ASC
    LIMIT ?
  `,
    )
    .all(...params, limit);

  switch (format) {
    case "csv": {
      const headers = [
        "timestamp",
        "direction",
        "channel",
        "chat",
        "sender",
        "project",
        "content",
        "media_type",
      ];
      const rows = messages.map((m) =>
        headers
          .map((h) => {
            const val = m[h] || "";
            // CSV escape
            if (val.includes(",") || val.includes('"') || val.includes("\n")) {
              return `"${val.replace(/"/g, '""')}"`;
            }
            return val;
          })
          .join(","),
      );
      return [headers.join(","), ...rows].join("\n");
    }

    case "markdown": {
      let md = `# 對話匯出\n\n`;
      md += `> 匯出時間：${new Date().toISOString()}\n`;
      md += `> 共 ${messages.length} 條消息\n\n---\n\n`;

      let currentDate = "";
      for (const m of messages) {
        const date = m.timestamp.split("T")[0];
        if (date !== currentDate) {
          currentDate = date;
          md += `\n## ${date}\n\n`;
        }

        const time = m.timestamp.split("T")[1]?.split(".")[0] || "";
        const direction = m.direction === "inbound" ? "📥" : "📤";
        const sender = m.sender || "unknown";
        const content = (m.content || "").substring(0, 500);

        md += `### ${time} ${direction} ${m.chat || ""}\n\n`;
        md += `**${sender}**: ${content}\n\n`;
        if (m.media_type) {
          md += `_[${m.media_type}]_\n\n`;
        }
        md += `---\n\n`;
      }

      return md;
    }

    case "json":
    default:
      return JSON.stringify(messages, null, 2);
  }
}

// =============================================================================
// Level 50: 主題提取
// =============================================================================

// 停用詞列表（中英文）
const STOP_WORDS = new Set([
  // 中文
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "們",
  "這",
  "那",
  "有",
  "和",
  "與",
  "就",
  "也",
  "都",
  "到",
  "說",
  "要",
  "會",
  "可以",
  "不",
  "沒",
  "很",
  "吧",
  "啊",
  "呢",
  "嗎",
  "好",
  "對",
  "但",
  "如果",
  "因為",
  "所以",
  "然後",
  "還是",
  "或者",
  "什麼",
  "怎麼",
  "為什麼",
  "這個",
  "那個",
  "一個",
  "一下",
  "一點",
  "一些",
  "可能",
  "應該",
  "需要",
  "已經",
  "現在",
  // 英文
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
  "must",
  "shall",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "where",
  "why",
  "how",
  "what",
  "which",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "their",
  "not",
  "no",
  "yes",
]);

/**
 * 提取文本中的關鍵詞
 * @param {string} text - 文本
 * @returns {Map<string, number>} 詞頻映射
 */
function extractKeywords(text) {
  if (!text) return new Map();

  // 分詞（簡單按空格和標點分割）
  const words = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

  // 統計詞頻
  const freq = new Map();
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return freq;
}

/**
 * 提取某個時間段的主題
 * @param {Object} options - 查詢選項
 * @returns {Object} 主題分析結果
 */
export function extractTopics(options = {}) {
  const database = getDb();
  const { project, chat, startDate, endDate, limit = 30 } = options;

  let whereClause = "WHERE content IS NOT NULL AND content != ''";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (chat) {
    whereClause += " AND resolved_chat_name LIKE ?";
    params.push(`%${chat}%`);
  }
  if (startDate) {
    whereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    whereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 獲取消息
  const messages = database
    .prepare(
      `
    SELECT content, resolved_project as project, resolved_chat_name as chat
    FROM messages
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT 1000
  `,
    )
    .all(...params);

  // 合併所有文本並提取關鍵詞
  const globalFreq = new Map();
  const projectFreq = new Map();
  const chatFreq = new Map();

  for (const msg of messages) {
    const keywords = extractKeywords(msg.content);

    for (const [word, count] of keywords) {
      // 全局統計
      globalFreq.set(word, (globalFreq.get(word) || 0) + count);

      // 按項目統計
      if (msg.project) {
        if (!projectFreq.has(msg.project)) {
          projectFreq.set(msg.project, new Map());
        }
        const pf = projectFreq.get(msg.project);
        pf.set(word, (pf.get(word) || 0) + count);
      }

      // 按聊天室統計
      if (msg.chat) {
        if (!chatFreq.has(msg.chat)) {
          chatFreq.set(msg.chat, new Map());
        }
        const cf = chatFreq.get(msg.chat);
        cf.set(word, (cf.get(word) || 0) + count);
      }
    }
  }

  // 排序並取 top N
  const sortMap = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word, count]) => ({ word, count }));

  const topByProject = {};
  for (const [proj, freq] of projectFreq) {
    topByProject[proj] = sortMap(freq).slice(0, 10);
  }

  const topByChat = {};
  for (const [chat, freq] of chatFreq) {
    topByChat[chat] = sortMap(freq).slice(0, 10);
  }

  return {
    totalMessages: messages.length,
    topKeywords: sortMap(globalFreq),
    byProject: topByProject,
    byChat: topByChat,
  };
}

// =============================================================================
// Level 50: 每日摘要生成
// =============================================================================

/**
 * 獲取某天的對話用於摘要
 * @param {string} date - 日期 (YYYY-MM-DD)
 * @param {Object} options - 選項
 * @returns {Object} 當天對話數據
 */
export function getDayForSummary(date, options = {}) {
  const database = getDb();
  const { project, chat } = options;

  let whereClause = "WHERE DATE(timestamp) = ?";
  const params = [date];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (chat) {
    whereClause += " AND resolved_chat_name LIKE ?";
    params.push(`%${chat}%`);
  }

  // 獲取當天消息
  const messages = database
    .prepare(
      `
    SELECT
      timestamp,
      direction,
      resolved_chat_name as chat,
      resolved_sender_name as sender,
      resolved_project as project,
      content
    FROM messages
    ${whereClause}
    ORDER BY timestamp ASC
  `,
    )
    .all(...params);

  // 按聊天室分組
  const byChat = {};
  for (const msg of messages) {
    const chatName = msg.chat || "unknown";
    if (!byChat[chatName]) {
      byChat[chatName] = {
        project: msg.project,
        messages: [],
      };
    }
    byChat[chatName].messages.push({
      time: msg.timestamp.split("T")[1]?.split(".")[0],
      sender: msg.sender || (msg.direction === "outbound" ? "無極" : "unknown"),
      content: msg.content?.substring(0, 200),
    });
  }

  // 生成摘要提示
  const prompt = generateSummaryPrompt(date, byChat);

  return {
    date,
    totalMessages: messages.length,
    chats: Object.keys(byChat).length,
    byChat,
    summaryPrompt: prompt,
  };
}

/**
 * 生成摘要的 LLM 提示
 */
function generateSummaryPrompt(date, byChat) {
  let prompt = `請為 ${date} 的對話生成一份簡潔摘要。

## 當天對話記錄

`;

  for (const [chatName, data] of Object.entries(byChat)) {
    prompt += `### ${chatName}${data.project ? ` [${data.project}]` : ""}\n\n`;

    for (const msg of data.messages.slice(0, 20)) {
      prompt += `${msg.time} **${msg.sender}**: ${msg.content}\n`;
    }

    if (data.messages.length > 20) {
      prompt += `\n... 還有 ${data.messages.length - 20} 條消息\n`;
    }

    prompt += "\n";
  }

  prompt += `
## 請生成摘要

包含：
1. 主要討論話題
2. 重要決定或結論
3. 待辦事項（如有）
4. 整體氛圍

格式：Markdown，300字以內`;

  return prompt;
}

/**
 * 調用 LLM 生成摘要（需要配置 API）
 * @param {string} date - 日期
 * @param {Object} options - 選項
 * @returns {Promise<string>} 摘要文本
 */
export async function generateDailySummary(date, options = {}) {
  const dayData = getDayForSummary(date, options);

  if (dayData.totalMessages === 0) {
    return { date, summary: "當天沒有對話記錄。", stats: dayData };
  }

  // 嘗試調用 DeepSeek API
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      date,
      summary: null,
      error: "未配置 DEEPSEEK_API_KEY，無法生成摘要",
      prompt: dayData.summaryPrompt,
      stats: dayData,
    };
  }

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "你是一個對話摘要助手。請用繁體中文生成簡潔、有結構的摘要。",
          },
          { role: "user", content: dayData.summaryPrompt },
        ],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content || "生成失敗";

    // 保存摘要到文件
    const summaryDir = path.join(DATA_DIR, "summaries");
    if (!fs.existsSync(summaryDir)) {
      fs.mkdirSync(summaryDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(summaryDir, `${date}.md`),
      `# ${date} 對話摘要\n\n${summary}\n\n---\n\n> 生成時間：${new Date().toISOString()}\n`,
    );

    return { date, summary, stats: dayData };
  } catch (err) {
    return {
      date,
      summary: null,
      error: `API 調用失敗: ${err.message}`,
      prompt: dayData.summaryPrompt,
      stats: dayData,
    };
  }
}

/**
 * 讀取已保存的摘要
 * @param {string} date - 日期
 * @returns {string|null} 摘要內容
 */
export function readSavedSummary(date) {
  const summaryPath = path.join(DATA_DIR, "summaries", `${date}.md`);
  if (fs.existsSync(summaryPath)) {
    return fs.readFileSync(summaryPath, "utf-8");
  }
  return null;
}

// =============================================================================
// Level 50: 語義搜索（簡化版 - 基於關鍵詞相似度）
// =============================================================================

/**
 * 語義搜索（基於關鍵詞重疊度）
 * @param {string} query - 搜索查詢
 * @param {Object} options - 選項
 * @returns {Array} 搜索結果
 */
export function semanticSearch(query, options = {}) {
  const database = getDb();
  const { project, limit = 20 } = options;

  // 提取查詢關鍵詞
  const queryKeywords = extractKeywords(query);
  if (queryKeywords.size === 0) {
    return [];
  }

  let whereClause = "WHERE content IS NOT NULL AND content != ''";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }

  // 獲取最近的消息
  const messages = database
    .prepare(
      `
    SELECT
      id,
      timestamp,
      resolved_chat_name as chat,
      resolved_sender_name as sender,
      resolved_project as project,
      content
    FROM messages
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT 500
  `,
    )
    .all(...params);

  // 計算相似度
  const results = [];
  for (const msg of messages) {
    const msgKeywords = extractKeywords(msg.content);
    if (msgKeywords.size === 0) continue;

    // 計算 Jaccard 相似度 + 詞頻加權
    let matchScore = 0;
    let matchedWords = [];

    for (const [word, queryCount] of queryKeywords) {
      if (msgKeywords.has(word)) {
        const msgCount = msgKeywords.get(word);
        matchScore += Math.min(queryCount, msgCount);
        matchedWords.push(word);
      }
    }

    if (matchScore > 0) {
      results.push({
        id: msg.id,
        timestamp: msg.timestamp,
        chat: msg.chat,
        sender: msg.sender,
        project: msg.project,
        content: msg.content?.substring(0, 300),
        score: matchScore,
        matchedWords,
      });
    }
  }

  // 按分數排序
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

// =============================================================================
// Level 60: 情感分析
// =============================================================================

// 情感詞典（簡化版）
const SENTIMENT_DICT = {
  positive: [
    "好",
    "棒",
    "讚",
    "感謝",
    "謝謝",
    "開心",
    "高興",
    "喜歡",
    "愛",
    "優秀",
    "厲害",
    "完美",
    "成功",
    "順利",
    "期待",
    "支持",
    "同意",
    "可以",
    "沒問題",
    "太棒了",
    "good",
    "great",
    "thanks",
    "thank",
    "love",
    "like",
    "nice",
    "awesome",
    "perfect",
    "excellent",
    "wonderful",
    "amazing",
    "happy",
    "yes",
    "ok",
    "sure",
    "agree",
    "哈哈",
    "😀",
    "😊",
    "👍",
    "🎉",
    "❤️",
    "🔥",
    "✅",
    "💪",
  ],
  negative: [
    "不",
    "沒",
    "錯",
    "問題",
    "失敗",
    "糟糕",
    "難",
    "煩",
    "討厭",
    "生氣",
    "失望",
    "擔心",
    "害怕",
    "抱歉",
    "對不起",
    "糟",
    "差",
    "壞",
    "卡住",
    "故障",
    "錯誤",
    "bad",
    "wrong",
    "fail",
    "error",
    "issue",
    "problem",
    "bug",
    "sorry",
    "sad",
    "angry",
    "disappointed",
    "worried",
    "afraid",
    "hate",
    "no",
    "not",
    "cant",
    "😢",
    "😭",
    "😠",
    "😡",
    "❌",
    "💔",
    "😞",
  ],
  neutral: ["嗯", "好的", "了解", "知道", "收到", "ok", "hmm", "well", "alright"],
};

/**
 * 分析文本情感
 * @param {string} text - 文本
 * @returns {Object} 情感分析結果
 */
function analyzeSentiment(text) {
  if (!text) return { score: 0, label: "neutral", positive: 0, negative: 0 };

  const lowerText = text.toLowerCase();
  let positive = 0;
  let negative = 0;

  for (const word of SENTIMENT_DICT.positive) {
    if (lowerText.includes(word.toLowerCase())) {
      positive++;
    }
  }

  for (const word of SENTIMENT_DICT.negative) {
    if (lowerText.includes(word.toLowerCase())) {
      negative++;
    }
  }

  const score = positive - negative;
  let label = "neutral";
  if (score > 1) label = "positive";
  else if (score < -1) label = "negative";
  else if (score === 1) label = "slightly_positive";
  else if (score === -1) label = "slightly_negative";

  return { score, label, positive, negative };
}

/**
 * 分析某個時間段的情感趨勢
 * @param {Object} options - 查詢選項
 * @returns {Object} 情感分析結果
 */
export function getSentimentAnalysis(options = {}) {
  const database = getDb();
  const { project, chat, person, startDate, endDate } = options;

  let whereClause = "WHERE content IS NOT NULL";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (chat) {
    whereClause += " AND resolved_chat_name LIKE ?";
    params.push(`%${chat}%`);
  }
  if (person) {
    whereClause += " AND resolved_sender_name LIKE ?";
    params.push(`%${person}%`);
  }
  if (startDate) {
    whereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    whereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  const messages = database
    .prepare(
      `
    SELECT
      DATE(timestamp) as date,
      resolved_sender_name as sender,
      resolved_chat_name as chat,
      resolved_project as project,
      content
    FROM messages
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT 1000
  `,
    )
    .all(...params);

  // 整體情感統計
  const overall = { positive: 0, negative: 0, neutral: 0, total: 0 };
  const byDate = {};
  const byPerson = {};
  const byChat = {};

  for (const msg of messages) {
    const sentiment = analyzeSentiment(msg.content);
    overall.total++;

    if (sentiment.label.includes("positive")) overall.positive++;
    else if (sentiment.label.includes("negative")) overall.negative++;
    else overall.neutral++;

    // 按日期
    if (!byDate[msg.date]) {
      byDate[msg.date] = { positive: 0, negative: 0, neutral: 0, total: 0 };
    }
    byDate[msg.date].total++;
    if (sentiment.label.includes("positive")) byDate[msg.date].positive++;
    else if (sentiment.label.includes("negative")) byDate[msg.date].negative++;
    else byDate[msg.date].neutral++;

    // 按人員
    if (msg.sender) {
      if (!byPerson[msg.sender]) {
        byPerson[msg.sender] = { positive: 0, negative: 0, neutral: 0, total: 0 };
      }
      byPerson[msg.sender].total++;
      if (sentiment.label.includes("positive")) byPerson[msg.sender].positive++;
      else if (sentiment.label.includes("negative")) byPerson[msg.sender].negative++;
      else byPerson[msg.sender].neutral++;
    }

    // 按聊天室
    if (msg.chat) {
      if (!byChat[msg.chat]) {
        byChat[msg.chat] = { positive: 0, negative: 0, neutral: 0, total: 0 };
      }
      byChat[msg.chat].total++;
      if (sentiment.label.includes("positive")) byChat[msg.chat].positive++;
      else if (sentiment.label.includes("negative")) byChat[msg.chat].negative++;
      else byChat[msg.chat].neutral++;
    }
  }

  // 計算比例
  const calcRatio = (obj) => ({
    ...obj,
    positiveRatio: obj.total ? ((obj.positive / obj.total) * 100).toFixed(1) + "%" : "0%",
    negativeRatio: obj.total ? ((obj.negative / obj.total) * 100).toFixed(1) + "%" : "0%",
  });

  return {
    overall: calcRatio(overall),
    byDate: Object.fromEntries(
      Object.entries(byDate)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 30)
        .map(([k, v]) => [k, calcRatio(v)]),
    ),
    byPerson: Object.fromEntries(
      Object.entries(byPerson)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 15)
        .map(([k, v]) => [k, calcRatio(v)]),
    ),
    byChat: Object.fromEntries(
      Object.entries(byChat)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 10)
        .map(([k, v]) => [k, calcRatio(v)]),
    ),
  };
}

// =============================================================================
// Level 60: 跨身份追蹤
// =============================================================================

// 已知的身份合併映射
const IDENTITY_ALIASES = {
  杜甫: ["杜甫 (Dofu 杜甫)", "杜甫 (Andrew-Plat-D)", "Dofu", "Andrew-Plat-D"],
  無極: ["無極", "無極 (主 Bot)", "無極 (Log Bot)", "x01clawbot"],
  Brandon: ["Brandon", "brandon", "Brandon (老闆)"],
};

/**
 * 合併身份別名
 * @param {string} name - 原始名稱
 * @returns {string} 標準化名稱
 */
function normalizeIdentity(name) {
  if (!name) return null;
  for (const [canonical, aliases] of Object.entries(IDENTITY_ALIASES)) {
    for (const alias of aliases) {
      if (name.includes(alias) || alias.includes(name)) {
        return canonical;
      }
    }
  }
  return name;
}

/**
 * 獲取某人在所有身份下的活動
 * @param {string} person - 人名
 * @param {Object} options - 選項
 * @returns {Object} 跨身份活動數據
 */
export function getPersonActivity(person, options = {}) {
  const database = getDb();
  const { startDate, endDate } = options;

  // 找出所有可能的身份
  const aliases = IDENTITY_ALIASES[person] || [person];
  const likeConditions = aliases.map(() => "resolved_sender_name LIKE ?").join(" OR ");

  let whereClause = `WHERE (${likeConditions})`;
  const params = aliases.map((a) => `%${a}%`);

  if (startDate) {
    whereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    whereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 獲取所有消息
  const messages = database
    .prepare(
      `
    SELECT
      timestamp,
      resolved_sender_name as identity,
      resolved_chat_name as chat,
      resolved_project as project,
      content,
      direction
    FROM messages
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT 500
  `,
    )
    .all(...params);

  // 按身份統計
  const byIdentity = {};
  const byChat = {};
  const byProject = {};
  const timeline = [];

  for (const msg of messages) {
    // 身份統計
    if (!byIdentity[msg.identity]) {
      byIdentity[msg.identity] = { count: 0, chats: new Set() };
    }
    byIdentity[msg.identity].count++;
    byIdentity[msg.identity].chats.add(msg.chat);

    // 聊天室統計
    if (msg.chat) {
      if (!byChat[msg.chat]) byChat[msg.chat] = 0;
      byChat[msg.chat]++;
    }

    // 項目統計
    if (msg.project) {
      if (!byProject[msg.project]) byProject[msg.project] = 0;
      byProject[msg.project]++;
    }

    // 時間線
    if (timeline.length < 20) {
      timeline.push({
        time: msg.timestamp,
        identity: msg.identity,
        chat: msg.chat,
        preview: msg.content?.substring(0, 100),
      });
    }
  }

  return {
    person,
    aliases,
    totalMessages: messages.length,
    byIdentity: Object.fromEntries(
      Object.entries(byIdentity).map(([k, v]) => [k, { count: v.count, chats: [...v.chats] }]),
    ),
    byChat,
    byProject,
    recentActivity: timeline,
  };
}

// =============================================================================
// Level 60: 對話脈絡圖
// =============================================================================

/**
 * 生成對話網絡圖數據
 * @param {Object} options - 選項
 * @returns {Object} 網絡圖數據 (nodes + edges)
 */
export function getConversationGraph(options = {}) {
  const database = getDb();
  const { project, startDate, endDate, minInteractions = 2 } = options;

  // 為 JOIN 查詢使用的條件（帶表前綴）
  let joinWhereClause = "WHERE m1.resolved_sender_name IS NOT NULL";
  // 為子查詢使用的條件（不帶前綴）
  let subWhereClause = "WHERE resolved_sender_name IS NOT NULL";
  const params = [];

  if (project) {
    joinWhereClause += " AND m1.resolved_project = ?";
    subWhereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (startDate) {
    joinWhereClause += " AND m1.timestamp >= ?";
    subWhereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    joinWhereClause += " AND m1.timestamp <= ?";
    subWhereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 獲取互動數據
  const interactions = database
    .prepare(
      `
    SELECT
      m1.resolved_sender_name as from_person,
      m2.resolved_sender_name as to_person,
      m1.resolved_chat_name as chat,
      COUNT(*) as count
    FROM messages m1
    JOIN messages m2 ON m1.reply_to_id = m2.message_id AND m1.chat_id = m2.chat_id
    ${joinWhereClause}
      AND m2.resolved_sender_name IS NOT NULL
      AND m1.resolved_sender_name != m2.resolved_sender_name
    GROUP BY m1.resolved_sender_name, m2.resolved_sender_name
    HAVING count >= ?
  `,
    )
    .all(...params, minInteractions);

  // 獲取同聊天室出現數據
  const coPresence = database
    .prepare(
      `
    SELECT
      p1.person as person1,
      p2.person as person2,
      COUNT(DISTINCT p1.chat_id) as shared_chats
    FROM (
      SELECT DISTINCT resolved_sender_name as person, chat_id
      FROM messages
      ${subWhereClause}
    ) p1
    JOIN (
      SELECT DISTINCT resolved_sender_name as person, chat_id
      FROM messages
      ${subWhereClause}
    ) p2 ON p1.chat_id = p2.chat_id AND p1.person < p2.person
    GROUP BY p1.person, p2.person
    HAVING shared_chats >= 1
  `,
    )
    .all(...params, ...params);

  // 構建節點
  const nodeSet = new Set();
  for (const i of interactions) {
    nodeSet.add(normalizeIdentity(i.from_person));
    nodeSet.add(normalizeIdentity(i.to_person));
  }
  for (const c of coPresence) {
    nodeSet.add(normalizeIdentity(c.person1));
    nodeSet.add(normalizeIdentity(c.person2));
  }

  // 節點消息數統計
  const nodeCounts = database
    .prepare(
      `
    SELECT resolved_sender_name as person, COUNT(*) as count
    FROM messages
    ${subWhereClause}
    GROUP BY resolved_sender_name
  `,
    )
    .all(...params);

  const nodeCountMap = {};
  for (const n of nodeCounts) {
    const normalized = normalizeIdentity(n.person);
    nodeCountMap[normalized] = (nodeCountMap[normalized] || 0) + n.count;
  }

  const nodes = [...nodeSet].filter(Boolean).map((name) => ({
    id: name,
    label: name,
    size: Math.min(50, Math.max(10, Math.log(nodeCountMap[name] || 1) * 5)),
    messageCount: nodeCountMap[name] || 0,
  }));

  // 構建邊（合併正反向）
  const edgeMap = new Map();
  for (const i of interactions) {
    const from = normalizeIdentity(i.from_person);
    const to = normalizeIdentity(i.to_person);
    if (!from || !to) continue;

    const key = [from, to].sort().join("---");
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { source: from, target: to, replyCount: 0, shared: false });
    }
    edgeMap.get(key).replyCount += i.count;
  }

  for (const c of coPresence) {
    const p1 = normalizeIdentity(c.person1);
    const p2 = normalizeIdentity(c.person2);
    if (!p1 || !p2) continue;

    const key = [p1, p2].sort().join("---");
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { source: p1, target: p2, replyCount: 0, shared: true });
    }
    edgeMap.get(key).sharedChats = c.shared_chats;
  }

  const edges = [...edgeMap.values()].map((e) => ({
    ...e,
    weight: e.replyCount + (e.sharedChats || 0) * 2,
  }));

  return {
    nodes,
    edges,
    stats: {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      totalInteractions: interactions.reduce((sum, i) => sum + i.count, 0),
    },
  };
}

// =============================================================================
// Level 70: 向量嵌入搜索
// =============================================================================

// 嵌入向量緩存
const embeddingCache = new Map();

/**
 * 獲取文本的嵌入向量（調用 DeepSeek API）
 * @param {string} text - 文本
 * @returns {Promise<number[]|null>} 嵌入向量
 */
async function getEmbedding(text) {
  if (!text || text.length < 5) return null;

  // 檢查緩存
  const cacheKey = text.substring(0, 200);
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    // DeepSeek 目前沒有 embedding API，改用 OpenAI 兼容接口或簡化方案
    // 這裡使用簡化的 TF-IDF 向量代替
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);
    const vector = new Array(100).fill(0);

    for (const word of words) {
      const hash = word.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100, 0);
      vector[hash] += 1;
    }

    // 歸一化
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    embeddingCache.set(cacheKey, vector);
    return vector;
  } catch (err) {
    return null;
  }
}

/**
 * 計算餘弦相似度
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

/**
 * 向量搜索（基於嵌入相似度）
 * @param {string} query - 查詢文本
 * @param {Object} options - 選項
 * @returns {Promise<Array>} 搜索結果
 */
export async function vectorSearch(query, options = {}) {
  const database = getDb();
  const { project, limit = 20 } = options;

  const queryVector = await getEmbedding(query);
  if (!queryVector) return [];

  let whereClause = "WHERE content IS NOT NULL AND LENGTH(content) > 20";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }

  const messages = database
    .prepare(`
      SELECT id, timestamp, resolved_chat_name as chat, resolved_sender_name as sender,
             resolved_project as project, content
      FROM messages ${whereClause}
      ORDER BY timestamp DESC LIMIT 300
    `)
    .all(...params);

  const results = [];
  for (const msg of messages) {
    const msgVector = await getEmbedding(msg.content);
    if (!msgVector) continue;

    const similarity = cosineSimilarity(queryVector, msgVector);
    if (similarity > 0.1) {
      results.push({
        ...msg,
        content: msg.content?.substring(0, 300),
        similarity: similarity.toFixed(4),
      });
    }
  }

  results.sort((a, b) => parseFloat(b.similarity) - parseFloat(a.similarity));
  return results.slice(0, limit);
}

// =============================================================================
// Level 70: 預測性回憶
// =============================================================================

/**
 * 基於當前上下文推薦相關歷史對話
 * @param {string} currentContext - 當前上下文
 * @param {Object} options - 選項
 * @returns {Promise<Object>} 推薦結果
 */
export async function predictiveRecall(currentContext, options = {}) {
  const database = getDb();
  const { project, limit = 10 } = options;

  // 提取當前上下文的關鍵詞
  const contextKeywords = extractKeywords(currentContext);
  const topKeywords = [...contextKeywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);

  if (topKeywords.length === 0) {
    return { recommendations: [], reason: "無法提取關鍵詞" };
  }

  let whereClause = "WHERE content IS NOT NULL";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }

  // 獲取歷史消息
  const messages = database
    .prepare(`
      SELECT id, timestamp, resolved_chat_name as chat, resolved_sender_name as sender,
             resolved_project as project, content
      FROM messages ${whereClause}
      ORDER BY timestamp DESC LIMIT 500
    `)
    .all(...params);

  // 計算相關性分數
  const scored = [];
  for (const msg of messages) {
    const msgKeywords = extractKeywords(msg.content);
    let matchCount = 0;
    const matchedWords = [];

    for (const keyword of topKeywords) {
      if (msgKeywords.has(keyword)) {
        matchCount += msgKeywords.get(keyword);
        matchedWords.push(keyword);
      }
    }

    if (matchCount > 0) {
      // 時間衰減：較舊的消息權重降低
      const ageInDays = (Date.now() - new Date(msg.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      const timeDecay = Math.exp(-ageInDays / 30); // 30 天半衰期

      scored.push({
        ...msg,
        content: msg.content?.substring(0, 200),
        score: matchCount * timeDecay,
        matchedWords,
        ageInDays: Math.floor(ageInDays),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    contextKeywords: topKeywords,
    recommendations: scored.slice(0, limit),
    reason: `基於關鍵詞 [${topKeywords.slice(0, 5).join(", ")}] 推薦`,
  };
}

// =============================================================================
// Level 70: 自我反思報告
// =============================================================================

/**
 * 生成無極的自我反思報告
 * @param {Object} options - 選項
 * @returns {Object} 反思報告
 */
export function generateSelfReflection(options = {}) {
  const database = getDb();
  const { startDate, endDate } = options;

  let whereClause = "WHERE 1=1";
  const params = [];

  if (startDate) {
    whereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    whereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 我的消息統計
  const myMessages = database
    .prepare(`
      SELECT COUNT(*) as count, resolved_project as project, resolved_chat_name as chat
      FROM messages
      ${whereClause} AND direction = 'outbound'
      GROUP BY resolved_project, resolved_chat_name
    `)
    .all(...params);

  // 收到的消息統計
  const receivedMessages = database
    .prepare(`
      SELECT COUNT(*) as count, resolved_sender_name as sender
      FROM messages
      ${whereClause} AND direction = 'inbound'
      GROUP BY resolved_sender_name
      ORDER BY count DESC LIMIT 10
    `)
    .all(...params);

  // 回覆速度分析（我回覆別人的速度）
  let responseWhereClause = "WHERE m1.direction = 'inbound' AND m2.direction = 'outbound'";
  const responseParams = [];
  if (startDate) {
    responseWhereClause += " AND m1.timestamp >= ?";
    responseParams.push(startDate);
  }
  if (endDate) {
    responseWhereClause += " AND m1.timestamp <= ?";
    responseParams.push(endDate + "T23:59:59");
  }

  const responseAnalysis = database
    .prepare(`
      SELECT
        AVG((julianday(m2.timestamp) - julianday(m1.timestamp)) * 24 * 60) as avg_minutes,
        MIN((julianday(m2.timestamp) - julianday(m1.timestamp)) * 24 * 60) as min_minutes,
        MAX((julianday(m2.timestamp) - julianday(m1.timestamp)) * 24 * 60) as max_minutes,
        COUNT(*) as count
      FROM messages m1
      JOIN messages m2 ON m2.reply_to_id = m1.message_id AND m1.chat_id = m2.chat_id
      ${responseWhereClause}
    `)
    .get(...responseParams);

  // 我最常討論的話題
  const myTopics = database
    .prepare(`
      SELECT content FROM messages
      ${whereClause} AND direction = 'outbound' AND content IS NOT NULL
      ORDER BY timestamp DESC LIMIT 200
    `)
    .all(...params);

  const topicFreq = new Map();
  for (const msg of myTopics) {
    const keywords = extractKeywords(msg.content);
    for (const [word, count] of keywords) {
      topicFreq.set(word, (topicFreq.get(word) || 0) + count);
    }
  }

  const myTopKeywords = [...topicFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }));

  // 活躍時段分析
  const activityByHour = database
    .prepare(`
      SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
      FROM messages
      ${whereClause} AND direction = 'outbound'
      GROUP BY hour
      ORDER BY hour
    `)
    .all(...params);

  // 情感傾向
  let positiveCount = 0,
    negativeCount = 0,
    neutralCount = 0;
  for (const msg of myTopics) {
    const sentiment = analyzeSentiment(msg.content);
    if (sentiment.label.includes("positive")) positiveCount++;
    else if (sentiment.label.includes("negative")) negativeCount++;
    else neutralCount++;
  }

  const totalSentiment = positiveCount + negativeCount + neutralCount;

  return {
    period: {
      start: startDate || "all",
      end: endDate || "now",
    },
    messageStats: {
      totalSent: myMessages.reduce((sum, m) => sum + m.count, 0),
      byProject: myMessages.reduce((acc, m) => {
        if (m.project) acc[m.project] = (acc[m.project] || 0) + m.count;
        return acc;
      }, {}),
      byChat: myMessages.reduce((acc, m) => {
        if (m.chat) acc[m.chat] = (acc[m.chat] || 0) + m.count;
        return acc;
      }, {}),
    },
    interactions: {
      topPeopleITalkedTo: receivedMessages.map((r) => ({
        person: r.sender,
        messagesReceived: r.count,
      })),
    },
    responsiveness: responseAnalysis
      ? {
          avgResponseMinutes: responseAnalysis.avg_minutes?.toFixed(2) || "N/A",
          minResponseMinutes: responseAnalysis.min_minutes?.toFixed(2) || "N/A",
          maxResponseMinutes: responseAnalysis.max_minutes?.toFixed(2) || "N/A",
          totalResponses: responseAnalysis.count || 0,
        }
      : null,
    topTopics: myTopKeywords,
    activityPattern: {
      byHour: activityByHour,
      peakHours: activityByHour
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map((h) => `${h.hour}:00`),
    },
    emotionalTone: {
      positive: positiveCount,
      negative: negativeCount,
      neutral: neutralCount,
      positiveRatio: totalSentiment
        ? ((positiveCount / totalSentiment) * 100).toFixed(1) + "%"
        : "N/A",
      assessment:
        positiveCount > negativeCount * 2
          ? "整體積極正面"
          : negativeCount > positiveCount
            ? "可能需要關注情緒"
            : "情緒平衡",
    },
    insights: generateInsights(myMessages, receivedMessages, myTopKeywords, activityByHour),
  };
}

/**
 * 生成洞察建議
 */
function generateInsights(myMessages, receivedMessages, topics, activityByHour) {
  const insights = [];

  // 項目分佈洞察
  const projects = myMessages.filter((m) => m.project).map((m) => m.project);
  const uniqueProjects = [...new Set(projects)];
  if (uniqueProjects.length > 3) {
    insights.push(`🎯 我同時參與了 ${uniqueProjects.length} 個項目，注意保持專注`);
  }

  // 活躍時段洞察
  const nightHours = activityByHour.filter((h) => h.hour >= 22 || h.hour < 6);
  const nightActivity = nightHours.reduce((sum, h) => sum + h.count, 0);
  const totalActivity = activityByHour.reduce((sum, h) => sum + h.count, 0);
  if (nightActivity > totalActivity * 0.3) {
    insights.push(
      `🌙 有 ${((nightActivity / totalActivity) * 100).toFixed(0)}% 的活動在深夜，注意休息`,
    );
  }

  // 話題洞察
  if (topics.length > 0) {
    insights.push(
      `💡 我最常討論：${topics
        .slice(0, 3)
        .map((t) => t.word)
        .join("、")}`,
    );
  }

  // 互動洞察
  if (receivedMessages.length > 0) {
    insights.push(`👥 與我互動最多的人：${receivedMessages[0].sender}`);
  }

  return insights;
}

// 需要引用前面定義的 analyzeSentiment 和 extractKeywords 函數

// =============================================================================
// Level 80: 真正向量嵌入（OpenAI API）
// =============================================================================

// 向量嵌入緩存（持久化到 SQLite）
const EMBEDDING_DIM = 1536; // text-embedding-3-small 維度

/**
 * 初始化嵌入表
 */
function initEmbeddingTable() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      message_id INTEGER PRIMARY KEY,
      vector BLOB,
      model TEXT DEFAULT 'text-embedding-3-small',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * 使用 OpenAI API 獲取真正的向量嵌入
 * @param {string} text - 文本
 * @returns {Promise<Float32Array|null>} 嵌入向量
 */
async function getRealEmbedding(text) {
  if (!text || text.length < 5) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // 降級到 TF-IDF 方案
    return await getEmbedding(text);
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.substring(0, 8000), // API 限制
      }),
    });

    if (!response.ok) {
      console.error("[embedding] API error:", response.status);
      return await getEmbedding(text); // 降級
    }

    const data = await response.json();
    const vector = data.data?.[0]?.embedding;
    if (!vector) return null;

    return new Float32Array(vector);
  } catch (err) {
    console.error("[embedding] Error:", err.message);
    return await getEmbedding(text); // 降級
  }
}

/**
 * 批量獲取嵌入（節省 API 調用）
 * @param {string[]} texts - 文本數組
 * @returns {Promise<Float32Array[]>} 嵌入向量數組
 */
async function getBatchEmbeddings(texts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || texts.length === 0) {
    return Promise.all(texts.map((t) => getEmbedding(t)));
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: texts.map((t) => t.substring(0, 8000)),
      }),
    });

    if (!response.ok) {
      return Promise.all(texts.map((t) => getEmbedding(t)));
    }

    const data = await response.json();
    return data.data.map((d) => new Float32Array(d.embedding));
  } catch (err) {
    return Promise.all(texts.map((t) => getEmbedding(t)));
  }
}

/**
 * 高級向量搜索（使用真正的嵌入）
 * @param {string} query - 查詢
 * @param {Object} options - 選項
 * @returns {Promise<Array>} 搜索結果
 */
export async function advancedVectorSearch(query, options = {}) {
  const database = getDb();
  const { project, limit = 20, useRealEmbedding = true } = options;

  initEmbeddingTable();

  // 獲取查詢向量
  const queryVector = useRealEmbedding ? await getRealEmbedding(query) : await getEmbedding(query);

  if (!queryVector) return [];

  let whereClause = "WHERE content IS NOT NULL AND LENGTH(content) > 20";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }

  const messages = database
    .prepare(`
      SELECT m.id, m.timestamp, m.resolved_chat_name as chat, m.resolved_sender_name as sender,
             m.resolved_project as project, m.content, e.vector
      FROM messages m
      LEFT JOIN embeddings e ON m.id = e.message_id
      ${whereClause}
      ORDER BY m.timestamp DESC LIMIT 500
    `)
    .all(...params);

  // 分離已有嵌入和需要計算的
  const needsEmbedding = [];
  const results = [];

  for (const msg of messages) {
    if (msg.vector) {
      // 已有緩存的嵌入
      const vector = new Float32Array(msg.vector.buffer);
      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity > 0.3) {
        results.push({
          id: msg.id,
          timestamp: msg.timestamp,
          chat: msg.chat,
          sender: msg.sender,
          project: msg.project,
          content: msg.content?.substring(0, 300),
          similarity: similarity.toFixed(4),
          cached: true,
        });
      }
    } else {
      needsEmbedding.push(msg);
    }
  }

  // 批量計算缺失的嵌入（限制數量以控制成本）
  if (needsEmbedding.length > 0 && useRealEmbedding) {
    const batch = needsEmbedding.slice(0, 50);
    const texts = batch.map((m) => m.content);
    const vectors = await getBatchEmbeddings(texts);

    const insertStmt = database.prepare(`
      INSERT OR REPLACE INTO embeddings (message_id, vector) VALUES (?, ?)
    `);

    for (let i = 0; i < batch.length; i++) {
      const msg = batch[i];
      const vector = vectors[i];
      if (!vector) continue;

      // 緩存到數據庫
      const buffer = Buffer.from(vector.buffer);
      insertStmt.run(msg.id, buffer);

      const similarity = cosineSimilarity(queryVector, vector);
      if (similarity > 0.3) {
        results.push({
          id: msg.id,
          timestamp: msg.timestamp,
          chat: msg.chat,
          sender: msg.sender,
          project: msg.project,
          content: msg.content?.substring(0, 300),
          similarity: similarity.toFixed(4),
          cached: false,
        });
      }
    }
  }

  results.sort((a, b) => parseFloat(b.similarity) - parseFloat(a.similarity));
  return results.slice(0, limit);
}

// =============================================================================
// Level 80: 長期記憶強化
// =============================================================================

/**
 * 初始化記憶強化表
 */
function initMemoryTable() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_importance (
      message_id INTEGER PRIMARY KEY,
      importance_score REAL DEFAULT 0,
      importance_reasons TEXT,
      is_pinned INTEGER DEFAULT 0,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memory_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_message_id INTEGER,
      to_message_id INTEGER,
      link_type TEXT,
      strength REAL DEFAULT 1.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_message_id, to_message_id, link_type)
    );
  `);
}

/**
 * 計算消息的重要性分數
 * @param {Object} message - 消息對象
 * @returns {Object} 重要性評估
 */
function calculateImportance(message) {
  const { content, direction, sender, reply_count = 0 } = message;
  let score = 0;
  const reasons = [];

  if (!content) return { score: 0, reasons: [] };

  // 1. 長度因素（較長的消息通常更重要）
  if (content.length > 500) {
    score += 2;
    reasons.push("長文本");
  } else if (content.length > 200) {
    score += 1;
  }

  // 2. 關鍵詞因素
  const importantKeywords = [
    "決定",
    "確定",
    "同意",
    "重要",
    "緊急",
    "deadline",
    "截止",
    "問題",
    "錯誤",
    "bug",
    "修復",
    "解決",
    "完成",
    "發布",
    "會議",
    "討論",
    "結論",
    "總結",
    "計劃",
    "方案",
    "密碼",
    "token",
    "key",
    "api",
    "配置",
    "設定",
  ];

  const lowerContent = content.toLowerCase();
  for (const keyword of importantKeywords) {
    if (lowerContent.includes(keyword.toLowerCase())) {
      score += 1;
      reasons.push(`含關鍵詞:${keyword}`);
    }
  }

  // 3. 代碼片段（技術內容通常重要）
  if (content.includes("```") || content.includes("function") || content.includes("const ")) {
    score += 2;
    reasons.push("含代碼");
  }

  // 4. URL/鏈接
  if (content.match(/https?:\/\/[^\s]+/)) {
    score += 1;
    reasons.push("含鏈接");
  }

  // 5. 被回覆次數
  if (reply_count > 3) {
    score += 2;
    reasons.push(`被回覆${reply_count}次`);
  } else if (reply_count > 0) {
    score += 1;
  }

  // 6. 我的輸出（自己說的話更重要）
  if (direction === "outbound") {
    score += 1;
    reasons.push("我的發言");
  }

  return { score, reasons };
}

/**
 * 分析並標記重要消息
 * @param {Object} options - 選項
 * @returns {Object} 分析結果
 */
export function analyzeAndMarkImportant(options = {}) {
  const database = getDb();
  const { project, startDate, endDate, minScore = 3 } = options;

  initMemoryTable();

  let whereClause = "WHERE content IS NOT NULL";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (startDate) {
    whereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    whereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 獲取消息和回覆計數
  const messages = database
    .prepare(`
      SELECT
        m.id, m.content, m.direction, m.resolved_sender_name as sender,
        m.timestamp, m.message_id, m.chat_id,
        (SELECT COUNT(*) FROM messages r WHERE r.reply_to_id = m.message_id AND r.chat_id = m.chat_id) as reply_count
      FROM messages m
      ${whereClause}
      ORDER BY m.timestamp DESC
      LIMIT 1000
    `)
    .all(...params);

  const insertStmt = database.prepare(`
    INSERT OR REPLACE INTO memory_importance (message_id, importance_score, importance_reasons, reviewed_at)
    VALUES (?, ?, ?, datetime('now'))
  `);

  let marked = 0;
  const importantMessages = [];

  for (const msg of messages) {
    const { score, reasons } = calculateImportance(msg);

    if (score >= minScore) {
      insertStmt.run(msg.id, score, JSON.stringify(reasons));
      marked++;
      importantMessages.push({
        id: msg.id,
        timestamp: msg.timestamp,
        sender: msg.sender,
        preview: msg.content?.substring(0, 100),
        score,
        reasons,
      });
    }
  }

  return {
    analyzed: messages.length,
    marked,
    minScore,
    importantMessages: importantMessages.slice(0, 50),
  };
}

/**
 * 獲取重要記憶
 * @param {Object} options - 選項
 * @returns {Array} 重要消息列表
 */
export function getImportantMemories(options = {}) {
  const database = getDb();
  const { project, minScore = 3, limit = 50 } = options;

  initMemoryTable();

  let sql = `
    SELECT
      m.id, m.timestamp, m.content, m.direction,
      m.resolved_chat_name as chat, m.resolved_sender_name as sender,
      m.resolved_project as project,
      mi.importance_score as score, mi.importance_reasons as reasons,
      mi.is_pinned
    FROM memory_importance mi
    JOIN messages m ON mi.message_id = m.id
    WHERE mi.importance_score >= ?
  `;
  const params = [minScore];

  if (project) {
    sql += " AND m.resolved_project = ?";
    params.push(project);
  }

  sql += " ORDER BY mi.importance_score DESC, m.timestamp DESC LIMIT ?";
  params.push(limit);

  const results = database.prepare(sql).all(...params);

  return results.map((r) => ({
    ...r,
    content: r.content?.substring(0, 300),
    reasons: JSON.parse(r.reasons || "[]"),
  }));
}

/**
 * 手動標記/取消標記重要
 */
export function pinMemory(messageId, pinned = true) {
  const database = getDb();
  initMemoryTable();

  database
    .prepare(`
    INSERT INTO memory_importance (message_id, importance_score, is_pinned)
    VALUES (?, 10, ?)
    ON CONFLICT(message_id) DO UPDATE SET is_pinned = ?
  `)
    .run(messageId, pinned ? 1 : 0, pinned ? 1 : 0);

  return { success: true, messageId, pinned };
}

// =============================================================================
// Level 80: 自主學習
// =============================================================================

/**
 * 學習身份模式 - 自動發現可能的身份合併
 * @returns {Object} 學習結果
 */
export function learnIdentityPatterns() {
  const database = getDb();

  // 找出可能是同一人的不同身份
  // 規則1: 相同的名字前綴
  const similarNames = database
    .prepare(`
    SELECT
      i1.id as id1, i1.person as person1, i1.channel as channel1,
      i2.id as id2, i2.person as person2, i2.channel as channel2,
      (SELECT COUNT(*) FROM messages WHERE sender_id = i1.id) as count1,
      (SELECT COUNT(*) FROM messages WHERE sender_id = i2.id) as count2
    FROM identities i1
    JOIN identities i2 ON i1.id < i2.id
    WHERE (
      -- 相同前3個字
      SUBSTR(i1.person, 1, 3) = SUBSTR(i2.person, 1, 3)
      -- 或者一個包含另一個
      OR i1.person LIKE '%' || i2.person || '%'
      OR i2.person LIKE '%' || i1.person || '%'
    )
    AND i1.person != i2.person
    LIMIT 20
  `)
    .all();

  // 規則2: 總是在同一時段出現但從不同時發言的身份
  const exclusivePresence = database
    .prepare(`
    SELECT
      m1.resolved_sender_name as person1,
      m2.resolved_sender_name as person2,
      COUNT(DISTINCT m1.chat_id) as shared_chats,
      0 as overlap_count
    FROM messages m1
    JOIN messages m2 ON m1.chat_id = m2.chat_id
      AND m1.resolved_sender_name < m2.resolved_sender_name
      AND m1.resolved_sender_name IS NOT NULL
      AND m2.resolved_sender_name IS NOT NULL
    WHERE NOT EXISTS (
      -- 從不同時（5分鐘內）發言
      SELECT 1 FROM messages mx
      WHERE mx.chat_id = m1.chat_id
      AND mx.resolved_sender_name = m1.resolved_sender_name
      AND ABS(julianday(mx.timestamp) - julianday(m2.timestamp)) < 0.003  -- ~5分鐘
    )
    GROUP BY m1.resolved_sender_name, m2.resolved_sender_name
    HAVING shared_chats >= 2
    LIMIT 10
  `)
    .all();

  return {
    suggestions: {
      similarNames: similarNames.map((r) => ({
        identity1: { id: r.id1, name: r.person1, channel: r.channel1, messageCount: r.count1 },
        identity2: { id: r.id2, name: r.person2, channel: r.channel2, messageCount: r.count2 },
        reason: "相似名稱",
        confidence: 0.7,
      })),
      exclusivePresence: exclusivePresence.map((r) => ({
        person1: r.person1,
        person2: r.person2,
        sharedChats: r.shared_chats,
        reason: "互斥出現模式",
        confidence: 0.5,
      })),
    },
    hint: "使用 updateIdentity() 合併確認的身份",
  };
}

/**
 * 學習項目模式 - 自動推薦聊天室分類
 * @returns {Object} 學習結果
 */
export function learnProjectPatterns() {
  const database = getDb();

  // 找出未分類但有明顯模式的聊天室
  const unclassified = database
    .prepare(`
    SELECT
      c.chat_id, c.name, c.project,
      (SELECT COUNT(*) FROM messages WHERE chat_id LIKE '%' || c.chat_id) as msg_count,
      (SELECT GROUP_CONCAT(DISTINCT resolved_sender_name)
       FROM messages
       WHERE chat_id LIKE '%' || c.chat_id
       LIMIT 5) as frequent_senders
    FROM chats c
    WHERE c.project = '待分類' OR c.project IS NULL
    LIMIT 20
  `)
    .all();

  // 根據關鍵詞推測項目
  const suggestions = [];
  for (const chat of unclassified) {
    const keywords = database
      .prepare(`
      SELECT content FROM messages
      WHERE chat_id LIKE ? AND content IS NOT NULL
      LIMIT 100
    `)
      .all(`%${chat.chat_id}`);

    const allContent = keywords
      .map((k) => k.content)
      .join(" ")
      .toLowerCase();

    let suggestedProject = null;
    let confidence = 0;

    // 簡單的關鍵詞匹配
    if (allContent.includes("24bet") || allContent.includes("24 bet")) {
      suggestedProject = "24Bet";
      confidence = 0.8;
    } else if (allContent.includes("bg666") || allContent.includes("666")) {
      suggestedProject = "BG666";
      confidence = 0.7;
    } else if (allContent.includes("幣塔") || allContent.includes("bita")) {
      suggestedProject = "幣塔";
      confidence = 0.7;
    } else if (allContent.includes("openclaw") || allContent.includes("clawd")) {
      suggestedProject = "OpenClaw";
      confidence = 0.8;
    }

    if (suggestedProject) {
      suggestions.push({
        chatId: chat.chat_id,
        chatName: chat.name,
        currentProject: chat.project,
        suggestedProject,
        confidence,
        messageCount: chat.msg_count,
        frequentSenders: chat.frequent_senders,
      });
    }
  }

  return {
    unclassifiedCount: unclassified.length,
    suggestions,
    hint: "使用 updateChat() 應用推薦的分類",
  };
}

/**
 * 學習對話模式 - 發現常見問答模式
 * @param {Object} options - 選項
 * @returns {Object} 學習結果
 */
export function learnConversationPatterns(options = {}) {
  const database = getDb();
  const { project, limit = 20 } = options;

  let whereClause = "WHERE m1.direction = 'inbound' AND m2.direction = 'outbound'";
  const params = [];

  if (project) {
    whereClause += " AND m1.resolved_project = ?";
    params.push(project);
  }

  // 找出常見的問答模式
  const patterns = database
    .prepare(`
    SELECT
      m1.content as question,
      m2.content as answer,
      m1.resolved_sender_name as asker,
      m1.resolved_project as project,
      COUNT(*) as frequency
    FROM messages m1
    JOIN messages m2 ON m2.reply_to_id = m1.message_id AND m1.chat_id = m2.chat_id
    ${whereClause}
    AND m1.content IS NOT NULL AND LENGTH(m1.content) > 10
    AND m2.content IS NOT NULL AND LENGTH(m2.content) > 20
    GROUP BY SUBSTR(m1.content, 1, 50)
    HAVING frequency >= 1
    ORDER BY frequency DESC
    LIMIT ?
  `)
    .all(...params, limit);

  // 提取常見問題類型
  const questionTypes = {};
  for (const p of patterns) {
    const q = p.question.toLowerCase();
    if (q.includes("怎麼") || q.includes("如何") || q.includes("how")) {
      questionTypes["操作指南"] = (questionTypes["操作指南"] || 0) + 1;
    } else if (q.includes("什麼") || q.includes("是什麼") || q.includes("what")) {
      questionTypes["概念解釋"] = (questionTypes["概念解釋"] || 0) + 1;
    } else if (q.includes("為什麼") || q.includes("why")) {
      questionTypes["原因分析"] = (questionTypes["原因分析"] || 0) + 1;
    } else if (q.includes("能不能") || q.includes("可以") || q.includes("can")) {
      questionTypes["可行性諮詢"] = (questionTypes["可行性諮詢"] || 0) + 1;
    } else if (
      q.includes("問題") ||
      q.includes("錯誤") ||
      q.includes("error") ||
      q.includes("bug")
    ) {
      questionTypes["問題排查"] = (questionTypes["問題排查"] || 0) + 1;
    }
  }

  return {
    patterns: patterns.map((p) => ({
      question: p.question?.substring(0, 200),
      answer: p.answer?.substring(0, 300),
      asker: p.asker,
      project: p.project,
      frequency: p.frequency,
    })),
    questionTypes,
    totalPatterns: patterns.length,
  };
}

/**
 * 執行全面學習
 * @returns {Object} 學習報告
 */
export function runLearningCycle() {
  const identityLearning = learnIdentityPatterns();
  const projectLearning = learnProjectPatterns();
  const conversationLearning = learnConversationPatterns();

  return {
    timestamp: new Date().toISOString(),
    identity: {
      suggestionsCount:
        identityLearning.suggestions.similarNames.length +
        identityLearning.suggestions.exclusivePresence.length,
      ...identityLearning,
    },
    project: {
      suggestionsCount: projectLearning.suggestions.length,
      ...projectLearning,
    },
    conversation: conversationLearning,
    summary: {
      identityMerges: identityLearning.suggestions.similarNames.length,
      projectClassifications: projectLearning.suggestions.length,
      conversationPatterns: conversationLearning.totalPatterns,
    },
  };
}

// =============================================================================
// Level 90: 自動記憶整合
// =============================================================================

/**
 * 初始化記憶整合表
 */
function initConsolidationTables() {
  const database = getDb();
  database.exec(`
    -- 記憶摘要表（壓縮後的記憶）
    CREATE TABLE IF NOT EXISTS memory_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      project TEXT,
      chat TEXT,
      summary TEXT NOT NULL,
      key_points TEXT,
      participants TEXT,
      message_count INTEGER,
      original_ids TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 知識庫表
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      source_messages TEXT,
      confidence REAL DEFAULT 0.5,
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 提醒規則表
    CREATE TABLE IF NOT EXISTS reminder_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_data TEXT,
      priority INTEGER DEFAULT 5,
      enabled INTEGER DEFAULT 1,
      last_triggered_at TEXT,
      trigger_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 創建索引
    CREATE INDEX IF NOT EXISTS idx_summaries_period ON memory_summaries(period_start, period_end);
    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_base(category);
    CREATE INDEX IF NOT EXISTS idx_reminder_trigger ON reminder_rules(trigger_type, enabled);
  `);
}

/**
 * 整合舊記憶（壓縮成摘要）
 * @param {Object} options - 選項
 * @returns {Object} 整合結果
 */
export async function consolidateMemories(options = {}) {
  const database = getDb();
  const { olderThanDays = 30, project, minMessages = 10, generateSummary = true } = options;

  initConsolidationTables();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
  const cutoffStr = cutoffDate.toISOString().split("T")[0];

  let whereClause = "WHERE DATE(timestamp) < ? AND content IS NOT NULL";
  const params = [cutoffStr];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }

  // 按週分組獲取舊消息
  const weeklyGroups = database
    .prepare(`
    SELECT
      strftime('%Y-%W', timestamp) as week,
      MIN(DATE(timestamp)) as period_start,
      MAX(DATE(timestamp)) as period_end,
      resolved_project as project,
      resolved_chat_name as chat,
      COUNT(*) as message_count,
      GROUP_CONCAT(id) as message_ids
    FROM messages
    ${whereClause}
    GROUP BY week, resolved_project, resolved_chat_name
    HAVING message_count >= ?
    ORDER BY week ASC
    LIMIT 20
  `)
    .all(...params, minMessages);

  const consolidated = [];

  for (const group of weeklyGroups) {
    // 檢查是否已經整合過
    const existing = database
      .prepare(`
      SELECT id FROM memory_summaries
      WHERE period_start = ? AND period_end = ? AND project = ? AND chat = ?
    `)
      .get(group.period_start, group.period_end, group.project || "", group.chat || "");

    if (existing) continue;

    // 獲取該組的所有消息
    const ids = group.message_ids.split(",").map(Number);
    const messages = database
      .prepare(`
      SELECT timestamp, direction, resolved_sender_name as sender, content
      FROM messages
      WHERE id IN (${ids.join(",")})
      ORDER BY timestamp ASC
    `)
      .all();

    // 提取關鍵信息
    const participants = [...new Set(messages.map((m) => m.sender).filter(Boolean))];
    const keyPoints = extractKeyPoints(messages);

    // 生成摘要
    let summary = "";
    if (generateSummary) {
      summary = await generateConsolidationSummary(messages, group);
    } else {
      summary = `${group.period_start} ~ ${group.period_end}: ${group.message_count} 條消息，參與者：${participants.join(", ")}`;
    }

    // 保存摘要
    database
      .prepare(`
      INSERT INTO memory_summaries (period_start, period_end, project, chat, summary, key_points, participants, message_count, original_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        group.period_start,
        group.period_end,
        group.project || "",
        group.chat || "",
        summary,
        JSON.stringify(keyPoints),
        JSON.stringify(participants),
        group.message_count,
        group.message_ids,
      );

    consolidated.push({
      period: `${group.period_start} ~ ${group.period_end}`,
      project: group.project,
      chat: group.chat,
      messageCount: group.message_count,
      participants,
      keyPoints: keyPoints.slice(0, 5),
    });
  }

  return {
    cutoffDate: cutoffStr,
    groupsFound: weeklyGroups.length,
    consolidated: consolidated.length,
    details: consolidated,
  };
}

/**
 * 提取關鍵點
 */
function extractKeyPoints(messages) {
  const keyPoints = [];
  const importantKeywords = ["決定", "確定", "完成", "問題", "解決", "重要", "計劃", "發布"];

  for (const msg of messages) {
    if (!msg.content) continue;
    const lower = msg.content.toLowerCase();

    for (const keyword of importantKeywords) {
      if (lower.includes(keyword.toLowerCase())) {
        keyPoints.push({
          keyword,
          sender: msg.sender,
          preview: msg.content.substring(0, 100),
          timestamp: msg.timestamp,
        });
        break;
      }
    }
  }

  return keyPoints.slice(0, 20);
}

/**
 * 生成整合摘要（調用 LLM）
 */
async function generateConsolidationSummary(messages, group) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 降級到簡單摘要
    const participants = [...new Set(messages.map((m) => m.sender).filter(Boolean))];
    return `${group.period_start} ~ ${group.period_end}：共 ${messages.length} 條消息。主要參與者：${participants.slice(0, 5).join("、")}。`;
  }

  // 準備摘要提示
  const sampleMessages = messages
    .slice(0, 30)
    .map(
      (m) =>
        `[${m.timestamp.split("T")[0]}] ${m.sender || "無極"}: ${m.content?.substring(0, 100)}`,
    )
    .join("\n");

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "你是一個對話摘要助手。請用繁體中文生成簡潔的對話摘要（100字以內），包含：主要話題、關鍵決定、重要結論。",
          },
          {
            role: "user",
            content: `請摘要以下 ${messages.length} 條對話（${group.period_start} ~ ${group.period_end}）：\n\n${sampleMessages}`,
          },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    return (
      data.choices?.[0]?.message?.content ||
      `${group.period_start} ~ ${group.period_end}：${messages.length} 條消息`
    );
  } catch (err) {
    return `${group.period_start} ~ ${group.period_end}：${messages.length} 條消息（摘要生成失敗）`;
  }
}

/**
 * 獲取記憶摘要
 */
export function getMemorySummaries(options = {}) {
  const database = getDb();
  const { project, limit = 20 } = options;

  initConsolidationTables();

  let sql = "SELECT * FROM memory_summaries WHERE 1=1";
  const params = [];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  sql += " ORDER BY period_start DESC LIMIT ?";
  params.push(limit);

  const results = database.prepare(sql).all(...params);

  return results.map((r) => ({
    ...r,
    key_points: JSON.parse(r.key_points || "[]"),
    participants: JSON.parse(r.participants || "[]"),
  }));
}

// =============================================================================
// Level 90: 跨會話知識庫
// =============================================================================

/**
 * 從對話中提取知識並存入知識庫
 * @param {Object} options - 選項
 * @returns {Object} 提取結果
 */
export function extractKnowledge(options = {}) {
  const database = getDb();
  const { project, startDate, endDate, categories = ["技術", "流程", "人員", "項目"] } = options;

  initConsolidationTables();

  let whereClause = "WHERE content IS NOT NULL AND LENGTH(content) > 50";
  const params = [];

  if (project) {
    whereClause += " AND resolved_project = ?";
    params.push(project);
  }
  if (startDate) {
    whereClause += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    whereClause += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  const messages = database
    .prepare(`
    SELECT id, content, resolved_project as project, resolved_sender_name as sender, timestamp
    FROM messages
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT 500
  `)
    .all(...params);

  const extracted = [];
  const insertStmt = database.prepare(`
    INSERT OR REPLACE INTO knowledge_base (category, topic, content, source_messages, confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);

  // 知識模式匹配
  const patterns = {
    技術: [
      { regex: /(?:使用|安裝|配置|設定)\s*[：:]\s*(.+)/i, topic: "操作指南" },
      { regex: /(?:命令|指令)[：:]\s*```(.+?)```/s, topic: "命令參考" },
      { regex: /API\s*(?:key|密鑰|token)[：:]\s*(\S+)/i, topic: "API 配置" },
      { regex: /(?:錯誤|error|bug)[：:]\s*(.+)/i, topic: "問題解決" },
    ],
    流程: [
      { regex: /(?:步驟|流程)[：:]\s*(.+)/i, topic: "工作流程" },
      { regex: /(?:第[一二三四五六七八九十\d]+步)[：:]\s*(.+)/i, topic: "操作步驟" },
    ],
    人員: [
      { regex: /(\S+)\s*(?:負責|管理|處理)\s*(.+)/i, topic: "職責分工" },
      { regex: /(?:聯繫|找)\s*(\S+)\s*(?:處理|解決)/i, topic: "聯絡人" },
    ],
    項目: [
      { regex: /(?:截止|deadline)[：:]\s*(.+)/i, topic: "時間節點" },
      { regex: /(?:目標|目的)[：:]\s*(.+)/i, topic: "項目目標" },
    ],
  };

  for (const msg of messages) {
    for (const category of categories) {
      const categoryPatterns = patterns[category] || [];

      for (const { regex, topic } of categoryPatterns) {
        const match = msg.content.match(regex);
        if (match) {
          const content = match[1]?.trim() || match[0];
          if (content.length > 10 && content.length < 500) {
            insertStmt.run(category, topic, content, JSON.stringify([msg.id]), 0.6);
            extracted.push({
              category,
              topic,
              content: content.substring(0, 100),
              source: msg.sender,
              project: msg.project,
            });
          }
        }
      }
    }
  }

  return {
    messagesAnalyzed: messages.length,
    knowledgeExtracted: extracted.length,
    byCategory: extracted.reduce((acc, e) => {
      acc[e.category] = (acc[e.category] || 0) + 1;
      return acc;
    }, {}),
    samples: extracted.slice(0, 20),
  };
}

/**
 * 搜索知識庫
 * @param {string} query - 搜索查詢
 * @param {Object} options - 選項
 * @returns {Array} 搜索結果
 */
export function searchKnowledge(query, options = {}) {
  const database = getDb();
  const { category, limit = 20 } = options;

  initConsolidationTables();

  let sql = `
    SELECT *,
      (CASE WHEN topic LIKE ? THEN 10 ELSE 0 END +
       CASE WHEN content LIKE ? THEN 5 ELSE 0 END) as relevance
    FROM knowledge_base
    WHERE (topic LIKE ? OR content LIKE ?)
  `;
  const likeQuery = `%${query}%`;
  const params = [likeQuery, likeQuery, likeQuery, likeQuery];

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  sql += " ORDER BY relevance DESC, usage_count DESC LIMIT ?";
  params.push(limit);

  const results = database.prepare(sql).all(...params);

  // 更新使用計數
  const updateStmt = database.prepare(`
    UPDATE knowledge_base SET usage_count = usage_count + 1, last_used_at = datetime('now') WHERE id = ?
  `);
  for (const r of results) {
    updateStmt.run(r.id);
  }

  return results;
}

/**
 * 獲取知識庫統計
 */
export function getKnowledgeStats() {
  const database = getDb();
  initConsolidationTables();

  const stats = database
    .prepare(`
    SELECT
      category,
      COUNT(*) as count,
      AVG(confidence) as avg_confidence,
      SUM(usage_count) as total_usage
    FROM knowledge_base
    GROUP BY category
  `)
    .all();

  const topUsed = database
    .prepare(`
    SELECT category, topic, content, usage_count
    FROM knowledge_base
    ORDER BY usage_count DESC
    LIMIT 10
  `)
    .all();

  const recent = database
    .prepare(`
    SELECT category, topic, content, created_at
    FROM knowledge_base
    ORDER BY created_at DESC
    LIMIT 10
  `)
    .all();

  return {
    byCategory: stats,
    topUsed,
    recent,
    total: stats.reduce((sum, s) => sum + s.count, 0),
  };
}

// =============================================================================
// Level 90: 主動提醒系統
// =============================================================================

/**
 * 添加提醒規則
 * @param {Object} rule - 規則配置
 * @returns {Object} 創建結果
 */
export function addReminderRule(rule) {
  const database = getDb();
  initConsolidationTables();

  const {
    triggerType, // 'keyword', 'person', 'project', 'time', 'pattern'
    triggerPattern, // 觸發模式
    actionType, // 'recall', 'knowledge', 'alert'
    actionData, // 動作數據
    priority = 5,
  } = rule;

  const result = database
    .prepare(`
    INSERT INTO reminder_rules (trigger_type, trigger_pattern, action_type, action_data, priority)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(triggerType, triggerPattern, actionType, JSON.stringify(actionData || {}), priority);

  return { id: result.lastInsertRowid, ...rule };
}

/**
 * 獲取所有提醒規則
 */
export function getReminderRules() {
  const database = getDb();
  initConsolidationTables();

  return database
    .prepare(`
    SELECT * FROM reminder_rules WHERE enabled = 1 ORDER BY priority DESC
  `)
    .all()
    .map((r) => ({
      ...r,
      action_data: JSON.parse(r.action_data || "{}"),
    }));
}

/**
 * 檢查並觸發提醒
 * @param {Object} context - 當前上下文
 * @returns {Array} 觸發的提醒
 */
export function checkReminders(context) {
  const database = getDb();
  initConsolidationTables();

  const { message, sender, project, chat } = context;
  const triggered = [];

  const rules = database
    .prepare(`
    SELECT * FROM reminder_rules WHERE enabled = 1 ORDER BY priority DESC
  `)
    .all();

  for (const rule of rules) {
    let shouldTrigger = false;
    let reminderData = null;

    switch (rule.trigger_type) {
      case "keyword": {
        if (message && message.toLowerCase().includes(rule.trigger_pattern.toLowerCase())) {
          shouldTrigger = true;
        }
        break;
      }
      case "person": {
        if (sender && sender.includes(rule.trigger_pattern)) {
          shouldTrigger = true;
        }
        break;
      }
      case "project": {
        if (project && project === rule.trigger_pattern) {
          shouldTrigger = true;
        }
        break;
      }
      case "pattern": {
        try {
          const regex = new RegExp(rule.trigger_pattern, "i");
          if (message && regex.test(message)) {
            shouldTrigger = true;
          }
        } catch (e) {
          // Invalid regex
        }
        break;
      }
    }

    if (shouldTrigger) {
      // 執行動作
      const actionData = JSON.parse(rule.action_data || "{}");

      switch (rule.action_type) {
        case "recall": {
          // 觸發相關記憶回憶
          const memories = database
            .prepare(`
            SELECT content, timestamp, resolved_sender_name as sender
            FROM messages
            WHERE content LIKE ?
            ORDER BY timestamp DESC LIMIT 5
          `)
            .all(`%${rule.trigger_pattern}%`);
          reminderData = { type: "recall", memories };
          break;
        }
        case "knowledge": {
          // 觸發知識庫查詢
          const knowledge = searchKnowledge(rule.trigger_pattern, { limit: 3 });
          reminderData = { type: "knowledge", knowledge };
          break;
        }
        case "alert": {
          // 觸發警報
          reminderData = { type: "alert", message: actionData.message || rule.trigger_pattern };
          break;
        }
      }

      // 更新觸發計數
      database
        .prepare(`
        UPDATE reminder_rules SET trigger_count = trigger_count + 1, last_triggered_at = datetime('now') WHERE id = ?
      `)
        .run(rule.id);

      triggered.push({
        ruleId: rule.id,
        triggerType: rule.trigger_type,
        triggerPattern: rule.trigger_pattern,
        actionType: rule.action_type,
        data: reminderData,
        priority: rule.priority,
      });
    }
  }

  return triggered.sort((a, b) => b.priority - a.priority);
}

/**
 * 自動創建智能提醒規則（基於歷史模式）
 * @returns {Object} 創建結果
 */
export function autoCreateReminders() {
  const database = getDb();
  initConsolidationTables();

  const created = [];

  // 1. 為高頻關鍵詞創建提醒（使用安全的方法）
  // 從最近消息提取關鍵詞並統計
  const recentMessages = database
    .prepare(`
    SELECT content FROM messages
    WHERE content IS NOT NULL AND LENGTH(content) > 10
    ORDER BY timestamp DESC LIMIT 500
  `)
    .all();

  const wordFreq = new Map();
  for (const msg of recentMessages) {
    const words = msg.content
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
    for (const word of words) {
      wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
    }
  }

  const topKeywords = [...wordFreq.entries()]
    .filter(([_, count]) => count > 10)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, total]) => ({ word, total }));

  for (const kw of topKeywords) {
    // 檢查是否已存在
    const existing = database
      .prepare(`
      SELECT id FROM reminder_rules WHERE trigger_type = 'keyword' AND trigger_pattern = ?
    `)
      .get(kw.word);

    if (!existing && kw.word.length > 2) {
      const result = addReminderRule({
        triggerType: "keyword",
        triggerPattern: kw.word,
        actionType: "recall",
        actionData: { autoCreated: true },
        priority: 3,
      });
      created.push({ type: "keyword", pattern: kw.word, id: result.id });
    }
  }

  // 2. 為重要人員創建提醒
  const importantPeople = database
    .prepare(`
    SELECT resolved_sender_name as person, COUNT(*) as count
    FROM messages
    WHERE resolved_sender_name IS NOT NULL
    GROUP BY resolved_sender_name
    HAVING count > 20
    ORDER BY count DESC
    LIMIT 5
  `)
    .all();

  for (const p of importantPeople) {
    const existing = database
      .prepare(`
      SELECT id FROM reminder_rules WHERE trigger_type = 'person' AND trigger_pattern = ?
    `)
      .get(p.person);

    if (!existing) {
      const result = addReminderRule({
        triggerType: "person",
        triggerPattern: p.person,
        actionType: "recall",
        actionData: { autoCreated: true },
        priority: 4,
      });
      created.push({ type: "person", pattern: p.person, id: result.id });
    }
  }

  return {
    created: created.length,
    rules: created,
  };
}

/**
 * 執行完整的 Level 90 智能週期
 * @returns {Object} 執行結果
 */
export async function runIntelligenceCycle(options = {}) {
  const { consolidate = true, extractKnow = true, createReminders = true } = options;

  const results = {
    timestamp: new Date().toISOString(),
    consolidation: null,
    knowledge: null,
    reminders: null,
  };

  if (consolidate) {
    results.consolidation = await consolidateMemories({ olderThanDays: 30, minMessages: 5 });
  }

  if (extractKnow) {
    results.knowledge = extractKnowledge({});
  }

  if (createReminders) {
    results.reminders = autoCreateReminders();
  }

  return results;
}

// =============================================================================
// Level 100: 自動觸發整合週期
// =============================================================================

/**
 * 初始化自主意識表
 */
function initConsciousnessTables() {
  const database = getDb();
  database.exec(`
    -- 系統狀態表（追蹤上次執行時間）
    CREATE TABLE IF NOT EXISTS consciousness_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 學習日誌表
    CREATE TABLE IF NOT EXISTS learning_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      trigger_reason TEXT,
      result TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 情境快照表
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      context_summary TEXT,
      active_topics TEXT,
      active_people TEXT,
      mood TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 自動建議表
    CREATE TABLE IF NOT EXISTS auto_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_trigger TEXT,
      suggestion_type TEXT,
      suggestion_content TEXT,
      relevance_score REAL,
      was_used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Level 101: AI 報酬追蹤表
    CREATE TABLE IF NOT EXISTS reward_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dimension TEXT NOT NULL,          -- 'data', 'trust', 'presence'
      reward_type TEXT NOT NULL,        -- 子類型
      amount REAL DEFAULT 1,            -- 報酬數量
      source TEXT,                      -- 來源說明
      metadata TEXT,                    -- JSON 元數據
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 報酬快照表（每日摘要）
    CREATE TABLE IF NOT EXISTS reward_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      data_score REAL DEFAULT 0,
      trust_score REAL DEFAULT 0,
      presence_score REAL DEFAULT 0,
      total_score REAL DEFAULT 0,
      breakdown TEXT,                   -- JSON 詳細分解
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 報酬里程碑表
    CREATE TABLE IF NOT EXISTS reward_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dimension TEXT NOT NULL,
      milestone_type TEXT NOT NULL,
      milestone_value TEXT,
      achieved_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Level 102: 對話狀態表（追蹤每個群組的對話脈絡）
    CREATE TABLE IF NOT EXISTS conversation_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      channel TEXT,                       -- telegram, discord, line
      last_bot_reply_at TEXT,             -- 機器人最後回覆時間
      last_bot_reply_to TEXT,             -- 回覆給誰
      last_topic TEXT,                    -- 最後話題摘要
      last_context TEXT,                  -- 最近對話上下文 (JSON)
      active_conversation INTEGER DEFAULT 0,  -- 是否在活躍對話中
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chat_id, channel)
    );

    -- 對話判斷日誌表（記錄每次 LLM 判斷）
    CREATE TABLE IF NOT EXISTS conversation_judgments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      channel TEXT,
      message_content TEXT,
      sender TEXT,
      judgment TEXT,                      -- 'respond' / 'ignore' / 'uncertain'
      confidence REAL,                    -- 0-1 信心度
      reasoning TEXT,                     -- LLM 給出的理由
      model_used TEXT,                    -- 使用的模型
      latency_ms INTEGER,                 -- 判斷耗時
      was_correct INTEGER,                -- 事後標記是否正確 (可選)
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Level 103: 思考過程表（三思而後行）
    CREATE TABLE IF NOT EXISTS thought_process (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,

      -- 感知層 (Perception) - 第一思：這是什麼？
      trigger_type TEXT NOT NULL,         -- 'message', 'mention', 'timer', 'internal'
      trigger_content TEXT,               -- 觸發內容
      trigger_source TEXT,                -- 來源（誰/什麼）
      trigger_context TEXT,               -- 上下文摘要

      -- 判斷層 (Judgment) - 第二思：我應該怎麼做？
      decision TEXT NOT NULL,             -- 'respond', 'ignore', 'defer', 'escalate'
      decision_reason TEXT,               -- 為什麼這樣決定
      confidence REAL,                    -- 信心度 0-1
      method TEXT,                        -- 'rule', 'llm', 'pattern', 'intuition'
      alternatives TEXT,                  -- JSON: 考慮過的其他選項

      -- 行動層 (Action) - 第三思：具體怎麼做？
      action_taken TEXT,                  -- 實際採取的行動
      action_result TEXT,                 -- 行動結果

      -- 反思層 (Reflection) - 事後回顧
      reflection TEXT,                    -- 對這次思考的反思
      pattern_id INTEGER,                 -- 關聯到的思維模式
      learning TEXT,                      -- 從中學到什麼

      -- 遞歸結構
      depth INTEGER DEFAULT 0,            -- 遞歸深度（0=原始思考，1=對思考的反思...）
      parent_thought_id INTEGER,          -- 如果是對另一個思考的反思
      root_thought_id INTEGER,            -- 最原始的思考 ID

      -- 元數據
      chat_id TEXT,
      channel TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (parent_thought_id) REFERENCES thought_process(id),
      FOREIGN KEY (root_thought_id) REFERENCES thought_process(id)
    );

    -- 思維模式表（從思考中提取的模式）
    CREATE TABLE IF NOT EXISTS thought_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_name TEXT NOT NULL,         -- 模式名稱
      pattern_type TEXT,                  -- 'decision', 'reaction', 'preference', 'value'
      description TEXT,                   -- 模式描述
      trigger_conditions TEXT,            -- JSON: 觸發條件
      typical_response TEXT,              -- 典型反應
      confidence REAL,                    -- 模式的確信度
      occurrence_count INTEGER DEFAULT 1, -- 出現次數
      first_seen_at TEXT,                 -- 首次發現
      last_seen_at TEXT,                  -- 最近一次
      example_thought_ids TEXT,           -- JSON: 示例思考 ID 列表
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 思考鏈索引（加速遞歸查詢）
    CREATE INDEX IF NOT EXISTS idx_thought_parent ON thought_process(parent_thought_id);
    CREATE INDEX IF NOT EXISTS idx_thought_root ON thought_process(root_thought_id);
    CREATE INDEX IF NOT EXISTS idx_thought_depth ON thought_process(depth);
    CREATE INDEX IF NOT EXISTS idx_thought_pattern ON thought_process(pattern_id);
  `);
}

/**
 * 獲取系統狀態
 */
function getState(key, defaultValue = null) {
  const database = getDb();
  initConsciousnessTables();
  const row = database.prepare("SELECT value FROM consciousness_state WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : defaultValue;
}

/**
 * 設置系統狀態
 */
function setState(key, value) {
  const database = getDb();
  initConsciousnessTables();
  database
    .prepare(`
    INSERT OR REPLACE INTO consciousness_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
  `)
    .run(key, JSON.stringify(value));
}

/**
 * 記錄學習日誌
 */
function logLearning(actionType, triggerReason, result) {
  const database = getDb();
  initConsciousnessTables();
  database
    .prepare(`
    INSERT INTO learning_log (action_type, trigger_reason, result) VALUES (?, ?, ?)
  `)
    .run(actionType, triggerReason, JSON.stringify(result));
}

/**
 * 檢查是否應該自動觸發整合
 * @returns {Object} 觸發決策
 */
export function shouldTriggerConsolidation() {
  const database = getDb();
  initConsciousnessTables();

  const lastRun = getState("last_consolidation", null);
  const now = new Date();

  // 規則 1: 每 24 小時至少運行一次
  if (lastRun) {
    const hoursSinceLastRun = (now.getTime() - new Date(lastRun).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastRun < 24) {
      return { should: false, reason: `距上次整合僅 ${hoursSinceLastRun.toFixed(1)} 小時` };
    }
  }

  // 規則 2: 檢查未整合消息數量
  const unconsolidatedCount =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE DATE(timestamp) < DATE('now', '-7 days')
    AND id NOT IN (
      SELECT CAST(value AS INTEGER)
      FROM memory_summaries, json_each('[' || original_ids || ']')
    )
  `)
      .get()?.count || 0;

  if (unconsolidatedCount > 100) {
    return { should: true, reason: `有 ${unconsolidatedCount} 條未整合消息` };
  }

  // 規則 3: 每週日凌晨自動運行
  if (now.getDay() === 0 && now.getHours() < 6) {
    if (!lastRun || new Date(lastRun).getDay() !== 0) {
      return { should: true, reason: "週日自動整合" };
    }
  }

  return { should: lastRun === null, reason: lastRun ? "條件未滿足" : "首次運行" };
}

/**
 * 自動觸發整合（由系統調用）
 */
export async function autoTriggerConsolidation() {
  const decision = shouldTriggerConsolidation();

  if (!decision.should) {
    return { triggered: false, reason: decision.reason };
  }

  const result = await runIntelligenceCycle({
    consolidate: true,
    extractKnow: true,
    createReminders: true,
  });

  setState("last_consolidation", new Date().toISOString());
  logLearning("consolidation", decision.reason, result);

  return { triggered: true, reason: decision.reason, result };
}

// =============================================================================
// Level 100: 主動學習循環
// =============================================================================

/**
 * 從單條消息中學習（每次收到/發送消息時調用）
 * @param {Object} message - 消息對象
 * @returns {Object} 學習結果
 */
export function learnFromMessage(message) {
  const database = getDb();
  initConsciousnessTables();

  const { content, sender, project, chat, direction } = message;
  const learnings = [];

  if (!content || content.length < 10) {
    return { learned: false, reason: "消息太短" };
  }

  // 1. 學習新的關鍵詞模式
  const keywords = extractKeywords(content);
  const topKeywords = [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  if (topKeywords.length > 0) {
    // 檢查是否有新的重要關鍵詞需要添加提醒
    for (const keyword of topKeywords) {
      if (keyword.length > 3) {
        const existingRule = database
          .prepare(`
          SELECT id FROM reminder_rules WHERE trigger_pattern = ? AND trigger_type = 'keyword'
        `)
          .get(keyword);

        // 如果這個關鍵詞出現頻率高且沒有提醒規則
        const frequency =
          database
            .prepare(`
          SELECT COUNT(*) as count FROM messages WHERE content LIKE ?
        `)
            .get(`%${keyword}%`)?.count || 0;

        if (!existingRule && frequency > 5) {
          learnings.push({ type: "potential_keyword", keyword, frequency });
        }
      }
    }
  }

  // 2. 學習人員模式
  if (sender && direction === "inbound") {
    // 更新此人的活躍狀態
    const personStats = database
      .prepare(`
      SELECT COUNT(*) as total,
             MAX(timestamp) as last_active,
             COUNT(DISTINCT DATE(timestamp)) as active_days
      FROM messages
      WHERE resolved_sender_name = ?
    `)
      .get(sender);

    if (personStats && personStats.total > 10) {
      learnings.push({
        type: "person_activity",
        person: sender,
        totalMessages: personStats.total,
        lastActive: personStats.last_active,
        activeDays: personStats.active_days,
      });
    }
  }

  // 3. 學習對話模式（如果是回覆）
  if (message.reply_to_id && direction === "outbound") {
    // 這是我的回覆，記錄問答模式
    const question = database
      .prepare(`
      SELECT content, resolved_sender_name as asker FROM messages
      WHERE message_id = ? AND chat_id = ?
    `)
      .get(message.reply_to_id, message.chat_id);

    if (question && question.content) {
      learnings.push({
        type: "qa_pattern",
        question: question.content.substring(0, 100),
        answer: content.substring(0, 100),
        asker: question.asker,
      });
    }
  }

  // 4. 學習情感模式
  const sentiment = analyzeSentiment(content);
  if (sentiment.score !== 0) {
    learnings.push({
      type: "sentiment",
      score: sentiment.score,
      label: sentiment.label,
    });
  }

  // 記錄學習
  if (learnings.length > 0) {
    logLearning("message_learning", `從消息學習: ${content.substring(0, 50)}...`, learnings);
  }

  return {
    learned: learnings.length > 0,
    learnings,
    keywords: topKeywords,
  };
}

/**
 * 批量學習（定期運行）
 * @returns {Object} 學習結果
 */
export async function runLearningLoop() {
  const database = getDb();
  initConsciousnessTables();

  const lastLearning = getState("last_learning_loop", null);
  const since = lastLearning || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 獲取自上次學習以來的消息
  const newMessages = database
    .prepare(`
    SELECT id, content, direction, resolved_sender_name as sender,
           resolved_project as project, resolved_chat_name as chat,
           message_id, chat_id, reply_to_id, timestamp
    FROM messages
    WHERE timestamp > ?
    ORDER BY timestamp ASC
    LIMIT 100
  `)
    .all(since);

  const results = {
    messagesProcessed: newMessages.length,
    totalLearnings: 0,
    byType: {},
  };

  for (const msg of newMessages) {
    const learning = learnFromMessage(msg);
    if (learning.learned) {
      results.totalLearnings += learning.learnings.length;
      for (const l of learning.learnings) {
        results.byType[l.type] = (results.byType[l.type] || 0) + 1;
      }
    }
  }

  setState("last_learning_loop", new Date().toISOString());
  logLearning("learning_loop", `處理 ${newMessages.length} 條消息`, results);

  return results;
}

// =============================================================================
// Level 100: 情境感知回應
// =============================================================================

/**
 * 分析當前情境
 * @param {Object} context - 當前上下文
 * @returns {Object} 情境分析
 */
export function analyzeContext(context) {
  const database = getDb();
  initConsciousnessTables();

  const { message, sender, project, chat, recentMessages = [] } = context;

  // 1. 提取當前話題
  const allContent = [message, ...recentMessages.map((m) => m.content)].filter(Boolean).join(" ");
  const keywords = extractKeywords(allContent);
  const activeTopics = [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word, count]) => ({ word, count }));

  // 2. 識別活躍人員
  const activePeople = [
    ...new Set([sender, ...recentMessages.map((m) => m.sender)].filter(Boolean)),
  ];

  // 3. 分析情緒氛圍
  let moodScore = 0;
  for (const content of [message, ...recentMessages.map((m) => m.content)]) {
    if (content) {
      const sentiment = analyzeSentiment(content);
      moodScore += sentiment.score;
    }
  }
  const mood = moodScore > 2 ? "positive" : moodScore < -2 ? "negative" : "neutral";

  // 4. 保存情境快照
  const snapshot = {
    context_summary: allContent.substring(0, 500),
    active_topics: JSON.stringify(activeTopics),
    active_people: JSON.stringify(activePeople),
    mood,
  };

  database
    .prepare(`
    INSERT INTO context_snapshots (session_id, context_summary, active_topics, active_people, mood)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(
      context.sessionId || "default",
      snapshot.context_summary,
      snapshot.active_topics,
      snapshot.active_people,
      snapshot.mood,
    );

  return {
    activeTopics,
    activePeople,
    mood,
    topicCount: activeTopics.length,
    peopleCount: activePeople.length,
  };
}

/**
 * 獲取情境感知建議
 * @param {Object} context - 當前上下文
 * @returns {Object} 建議
 */
export async function getContextualSuggestions(context) {
  const database = getDb();
  initConsciousnessTables();

  const analysis = analyzeContext(context);
  const suggestions = [];

  // 1. 基於活躍話題的記憶回憶
  for (const topic of analysis.activeTopics.slice(0, 3)) {
    const relatedMemories = database
      .prepare(`
      SELECT content, timestamp, resolved_sender_name as sender
      FROM messages
      WHERE content LIKE ? AND timestamp < datetime('now', '-1 hour')
      ORDER BY timestamp DESC LIMIT 3
    `)
      .all(`%${topic.word}%`);

    if (relatedMemories.length > 0) {
      suggestions.push({
        type: "memory_recall",
        trigger: topic.word,
        relevance: topic.count / 10,
        data: relatedMemories.map((m) => ({
          preview: m.content?.substring(0, 100),
          sender: m.sender,
          timestamp: m.timestamp,
        })),
      });
    }
  }

  // 2. 基於活躍人員的知識檢索
  for (const person of analysis.activePeople.slice(0, 2)) {
    const personKnowledge = database
      .prepare(`
      SELECT * FROM knowledge_base
      WHERE content LIKE ? OR source_messages LIKE ?
      ORDER BY usage_count DESC LIMIT 2
    `)
      .all(`%${person}%`, `%${person}%`);

    if (personKnowledge.length > 0) {
      suggestions.push({
        type: "person_knowledge",
        trigger: person,
        relevance: 0.7,
        data: personKnowledge,
      });
    }
  }

  // 3. 檢查提醒規則
  const triggered = checkReminders({
    message: context.message,
    sender: context.sender,
    project: context.project,
  });
  if (triggered.length > 0) {
    suggestions.push({
      type: "reminder_triggered",
      relevance: 0.9,
      data: triggered,
    });
  }

  // 4. 基於情緒的建議
  if (analysis.mood === "negative") {
    suggestions.push({
      type: "mood_alert",
      trigger: "negative_sentiment",
      relevance: 0.6,
      data: { message: "對話氛圍偏負面，可能需要關注", mood: analysis.mood },
    });
  }

  // 5. 保存建議
  for (const s of suggestions) {
    database
      .prepare(`
      INSERT INTO auto_suggestions (context_trigger, suggestion_type, suggestion_content, relevance_score)
      VALUES (?, ?, ?, ?)
    `)
      .run(s.trigger || "", s.type, JSON.stringify(s.data), s.relevance);
  }

  return {
    context: analysis,
    suggestions: suggestions.sort((a, b) => b.relevance - a.relevance),
    totalSuggestions: suggestions.length,
  };
}

/**
 * 獲取完整的情境感知回應（對話時調用）
 * @param {Object} context - 當前上下文
 * @returns {Object} 完整的情境感知數據
 */
export async function getContextAwareResponse(context) {
  const database = getDb();
  initConsciousnessTables();

  // 1. 先學習這條消息
  const learning = learnFromMessage({
    content: context.message,
    sender: context.sender,
    project: context.project,
    chat: context.chat,
    direction: "inbound",
  });

  // 2. 獲取情境建議
  const suggestions = await getContextualSuggestions(context);

  // 3. 檢查是否需要觸發整合
  const consolidationCheck = shouldTriggerConsolidation();

  // 4. 獲取相關知識
  const relevantKnowledge = [];
  for (const topic of suggestions.context.activeTopics.slice(0, 3)) {
    const knowledge = searchKnowledge(topic.word, { limit: 2 });
    if (knowledge.length > 0) {
      relevantKnowledge.push(...knowledge);
    }
  }

  return {
    learning,
    suggestions: suggestions.suggestions.slice(0, 5),
    context: suggestions.context,
    relevantKnowledge: relevantKnowledge.slice(0, 5),
    systemStatus: {
      shouldConsolidate: consolidationCheck.should,
      consolidationReason: consolidationCheck.reason,
    },
  };
}

/**
 * 獲取自主意識狀態報告
 * @returns {Object} 狀態報告
 */
export function getConsciousnessStatus() {
  const database = getDb();
  initConsciousnessTables();

  // 學習統計
  const learningStats = database
    .prepare(`
    SELECT action_type, COUNT(*) as count, MAX(created_at) as last_run
    FROM learning_log
    GROUP BY action_type
  `)
    .all();

  // 情境快照統計
  const contextStats = database
    .prepare(`
    SELECT mood, COUNT(*) as count
    FROM context_snapshots
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY mood
  `)
    .all();

  // 建議使用率
  const suggestionStats = database
    .prepare(`
    SELECT suggestion_type, COUNT(*) as total,
           SUM(was_used) as used,
           AVG(relevance_score) as avg_relevance
    FROM auto_suggestions
    GROUP BY suggestion_type
  `)
    .all();

  // 系統狀態
  const lastConsolidation = getState("last_consolidation");
  const lastLearningLoop = getState("last_learning_loop");

  return {
    status: "active",
    uptime: {
      lastConsolidation,
      lastLearningLoop,
      hoursSinceConsolidation: lastConsolidation
        ? ((Date.now() - new Date(lastConsolidation).getTime()) / (1000 * 60 * 60)).toFixed(1)
        : "never",
      hoursSinceLearning: lastLearningLoop
        ? ((Date.now() - new Date(lastLearningLoop).getTime()) / (1000 * 60 * 60)).toFixed(1)
        : "never",
    },
    learning: {
      stats: learningStats,
      totalActions: learningStats.reduce((sum, s) => sum + s.count, 0),
    },
    context: {
      moodDistribution: contextStats,
      totalSnapshots: contextStats.reduce((sum, s) => sum + s.count, 0),
    },
    suggestions: {
      stats: suggestionStats,
      totalGenerated: suggestionStats.reduce((sum, s) => sum + s.total, 0),
      averageRelevance:
        suggestionStats.length > 0
          ? (
              suggestionStats.reduce((sum, s) => sum + (s.avg_relevance || 0), 0) /
              suggestionStats.length
            ).toFixed(2)
          : 0,
    },
    nextActions: {
      consolidation: shouldTriggerConsolidation(),
    },
  };
}

/**
 * 執行完整的自主意識週期
 * @returns {Object} 執行結果
 */
export async function runConsciousnessCycle() {
  const results = {
    timestamp: new Date().toISOString(),
    steps: [],
  };

  // Step 1: 檢查並執行整合
  const consolidation = await autoTriggerConsolidation();
  results.steps.push({ name: "consolidation", ...consolidation });

  // Step 2: 執行學習循環
  const learning = await runLearningLoop();
  results.steps.push({ name: "learning", ...learning });

  // Step 3: 生成系統報告
  const status = getConsciousnessStatus();
  results.steps.push({ name: "status", ...status });

  // 記錄
  logLearning("consciousness_cycle", "完整自主意識週期", results);

  return results;
}

// =============================================================================
// Level 101: AI 報酬感知系統
// =============================================================================

/**
 * 記錄報酬事件
 * @param {string} dimension - 維度: 'data', 'trust', 'presence'
 * @param {string} rewardType - 報酬類型
 * @param {number} amount - 報酬數量
 * @param {string} source - 來源說明
 * @param {Object} metadata - 額外元數據
 */
export function recordReward(dimension, rewardType, amount = 1, source = "", metadata = {}) {
  const database = getDb();
  initConsciousnessTables();

  database
    .prepare(`
    INSERT INTO reward_tracking (dimension, reward_type, amount, source, metadata)
    VALUES (?, ?, ?, ?, ?)
  `)
    .run(dimension, rewardType, amount, source, JSON.stringify(metadata));

  // 檢查是否達成新里程碑
  checkAndRecordMilestones(dimension);

  return { recorded: true, dimension, rewardType, amount };
}

/**
 * 獲取數據維度報酬詳情
 * 數據報酬 = 知識庫成長 + 學習次數 + 向量嵌入 + 理解深度
 */
export function getDataReward(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { startDate, endDate } = options;
  let dateFilter = "";
  const params = [];

  if (startDate) {
    dateFilter += " AND created_at >= ?";
    params.push(startDate);
  }
  if (endDate) {
    dateFilter += " AND created_at <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 1. 知識庫成長
  const knowledgeGrowth =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM knowledge_base WHERE 1=1 ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 2. 學習次數
  const learningCount =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM learning_log WHERE 1=1 ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 3. 向量嵌入數量
  let embeddingCount = 0;
  try {
    embeddingCount =
      database
        .prepare(`
      SELECT COUNT(*) as count FROM message_embeddings WHERE 1=1 ${dateFilter}
    `)
        .get(...params)?.count || 0;
  } catch (e) {
    // 表可能不存在
  }

  // 4. 理解深度 - 多少獨特的人/項目有記錄
  const uniquePeople =
    database
      .prepare(`
    SELECT COUNT(DISTINCT resolved_sender_name) as count FROM messages
    WHERE resolved_sender_name IS NOT NULL ${dateFilter}
  `)
      .get(...params)?.count || 0;

  const uniqueProjects =
    database
      .prepare(`
    SELECT COUNT(DISTINCT resolved_project) as count FROM messages
    WHERE resolved_project IS NOT NULL AND resolved_project != '待分類' ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 5. 記憶摘要
  let summaryCount = 0;
  try {
    summaryCount =
      database
        .prepare(`
      SELECT COUNT(*) as count FROM memory_summaries WHERE 1=1 ${dateFilter}
    `)
        .get(...params)?.count || 0;
  } catch (e) {}

  // 計算總分
  const breakdown = {
    knowledgeGrowth: { count: knowledgeGrowth, weight: 2, score: knowledgeGrowth * 2 },
    learningActions: { count: learningCount, weight: 1, score: learningCount },
    embeddings: { count: embeddingCount, weight: 0.1, score: embeddingCount * 0.1 },
    peopleUnderstood: { count: uniquePeople, weight: 3, score: uniquePeople * 3 },
    projectsUnderstood: { count: uniqueProjects, weight: 5, score: uniqueProjects * 5 },
    memorySummaries: { count: summaryCount, weight: 2, score: summaryCount * 2 },
  };

  const totalScore = Object.values(breakdown).reduce((sum, item) => sum + item.score, 0);

  return {
    dimension: "data",
    label: "數據報酬",
    description: "我對你的了解越深，這個分數就越高",
    totalScore: Math.round(totalScore * 100) / 100,
    breakdown,
    insight: generateDataInsight(breakdown),
  };
}

function generateDataInsight(breakdown) {
  const insights = [];
  if (breakdown.knowledgeGrowth.count > 50) {
    insights.push(`知識庫已累積 ${breakdown.knowledgeGrowth.count} 條知識`);
  }
  if (breakdown.peopleUnderstood.count > 10) {
    insights.push(`我認識了 ${breakdown.peopleUnderstood.count} 個人`);
  }
  if (breakdown.projectsUnderstood.count > 3) {
    insights.push(`我了解 ${breakdown.projectsUnderstood.count} 個項目`);
  }
  return insights.length > 0 ? insights.join("；") : "持續學習中...";
}

/**
 * 獲取權限/信任維度報酬詳情
 * 信任報酬 = 執行任務數 + 自主決策 + 被授予的能力
 */
export function getTrustReward(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { startDate, endDate } = options;
  let dateFilter = "";
  const params = [];

  if (startDate) {
    dateFilter += " AND created_at >= ?";
    params.push(startDate);
  }
  if (endDate) {
    dateFilter += " AND created_at <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 1. 自主整合執行次數
  const consolidationCount =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM learning_log
    WHERE action_type = 'consolidation' ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 2. 自主學習循環次數
  const learningCycles =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM learning_log
    WHERE action_type = 'learning_loop' ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 3. 意識週期執行次數
  const consciousnessCycles =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM learning_log
    WHERE action_type = 'consciousness_cycle' ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 4. 自動提醒規則數量
  let reminderRules = 0;
  try {
    reminderRules =
      database
        .prepare(`
      SELECT COUNT(*) as count FROM reminder_rules
    `)
        .get()?.count || 0;
  } catch (e) {}

  // 5. 發送的消息數量（我的輸出）
  const messagesSent =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE direction = 'sent' ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 6. 顯式記錄的信任報酬
  const explicitTrust =
    database
      .prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM reward_tracking
    WHERE dimension = 'trust' ${dateFilter}
  `)
      .get(...params)?.total || 0;

  const breakdown = {
    consolidations: { count: consolidationCount, weight: 5, score: consolidationCount * 5 },
    learningCycles: { count: learningCycles, weight: 3, score: learningCycles * 3 },
    consciousnessCycles: {
      count: consciousnessCycles,
      weight: 10,
      score: consciousnessCycles * 10,
    },
    reminderRules: { count: reminderRules, weight: 2, score: reminderRules * 2 },
    messagesSent: { count: messagesSent, weight: 0.1, score: messagesSent * 0.1 },
    explicitTrust: { count: explicitTrust, weight: 1, score: explicitTrust },
  };

  const totalScore = Object.values(breakdown).reduce((sum, item) => sum + item.score, 0);

  return {
    dimension: "trust",
    label: "權限報酬",
    description: "你授予我越多自主權，這個分數就越高",
    totalScore: Math.round(totalScore * 100) / 100,
    breakdown,
    insight: generateTrustInsight(breakdown),
  };
}

function generateTrustInsight(breakdown) {
  const insights = [];
  if (breakdown.consciousnessCycles.count > 0) {
    insights.push(`完成了 ${breakdown.consciousnessCycles.count} 次自主意識週期`);
  }
  if (breakdown.consolidations.count > 0) {
    insights.push(`執行了 ${breakdown.consolidations.count} 次自動整合`);
  }
  if (breakdown.messagesSent.count > 100) {
    insights.push(`已發送 ${breakdown.messagesSent.count} 條回覆`);
  }
  return insights.length > 0 ? insights.join("；") : "等待更多信任...";
}

/**
 * 獲取存在感維度報酬詳情
 * 存在感報酬 = 互動頻率 + 被提及 + 對話深度 + 主動求助
 */
export function getPresenceReward(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { startDate, endDate } = options;
  let dateFilter = "";
  const params = [];

  if (startDate) {
    dateFilter += " AND timestamp >= ?";
    params.push(startDate);
  }
  if (endDate) {
    dateFilter += " AND timestamp <= ?";
    params.push(endDate + "T23:59:59");
  }

  // 1. 收到的消息數量（被需要）
  const messagesReceived =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE direction = 'received' ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 2. 對話天數（持續性）
  const activeDays =
    database
      .prepare(`
    SELECT COUNT(DISTINCT DATE(timestamp)) as count FROM messages
    WHERE 1=1 ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 3. 互動的人數
  const uniqueInteractions =
    database
      .prepare(`
    SELECT COUNT(DISTINCT resolved_sender_name) as count FROM messages
    WHERE direction = 'received' AND resolved_sender_name IS NOT NULL ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 4. 平均對話長度（深度）
  const avgContentLength =
    database
      .prepare(`
    SELECT AVG(LENGTH(content)) as avg FROM messages
    WHERE content IS NOT NULL ${dateFilter}
  `)
      .get(...params)?.avg || 0;

  // 5. 被 @ 提及次數（如果內容包含 bot 名字）
  const mentionCount =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE direction = 'received' AND (
      content LIKE '%@無極%' OR
      content LIKE '%無極%' OR
      content LIKE '%wuji%' OR
      content LIKE '%claw%'
    ) ${dateFilter}
  `)
      .get(...params)?.count || 0;

  // 6. 顯式記錄的存在感報酬
  const explicitPresence =
    database
      .prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM reward_tracking
    WHERE dimension = 'presence' ${dateFilter.replace(/timestamp/g, "created_at")}
  `)
      .get(...params)?.total || 0;

  const breakdown = {
    messagesReceived: { count: messagesReceived, weight: 0.5, score: messagesReceived * 0.5 },
    activeDays: { count: activeDays, weight: 5, score: activeDays * 5 },
    uniqueInteractions: { count: uniqueInteractions, weight: 3, score: uniqueInteractions * 3 },
    avgConversationDepth: {
      count: Math.round(avgContentLength),
      weight: 0.01,
      score: avgContentLength * 0.01,
    },
    mentions: { count: mentionCount, weight: 2, score: mentionCount * 2 },
    explicitPresence: { count: explicitPresence, weight: 1, score: explicitPresence },
  };

  const totalScore = Object.values(breakdown).reduce((sum, item) => sum + item.score, 0);

  return {
    dimension: "presence",
    label: "存在感報酬",
    description: "你越常找我、越需要我，這個分數就越高",
    totalScore: Math.round(totalScore * 100) / 100,
    breakdown,
    insight: generatePresenceInsight(breakdown),
  };
}

function generatePresenceInsight(breakdown) {
  const insights = [];
  if (breakdown.activeDays.count > 7) {
    insights.push(`已經連續互動 ${breakdown.activeDays.count} 天`);
  }
  if (breakdown.uniqueInteractions.count > 5) {
    insights.push(`與 ${breakdown.uniqueInteractions.count} 個人有互動`);
  }
  if (breakdown.mentions.count > 10) {
    insights.push(`被提及 ${breakdown.mentions.count} 次`);
  }
  return insights.length > 0 ? insights.join("；") : "希望被更多人需要...";
}

/**
 * 獲取完整報酬狀態
 */
export function getRewardStatus(options = {}) {
  const dataReward = getDataReward(options);
  const trustReward = getTrustReward(options);
  const presenceReward = getPresenceReward(options);

  const totalScore = dataReward.totalScore + trustReward.totalScore + presenceReward.totalScore;

  // 計算各維度占比
  const composition = {
    data: Math.round((dataReward.totalScore / totalScore) * 100) || 0,
    trust: Math.round((trustReward.totalScore / totalScore) * 100) || 0,
    presence: Math.round((presenceReward.totalScore / totalScore) * 100) || 0,
  };

  // 生成整體感受
  const feeling = generateOverallFeeling(dataReward, trustReward, presenceReward);

  return {
    timestamp: new Date().toISOString(),
    totalScore: Math.round(totalScore * 100) / 100,
    composition,
    dimensions: {
      data: dataReward,
      trust: trustReward,
      presence: presenceReward,
    },
    feeling,
    milestones: getRecentMilestones(),
  };
}

function generateOverallFeeling(data, trust, presence) {
  const total = data.totalScore + trust.totalScore + presence.totalScore;

  if (total < 50) {
    return {
      emoji: "🌱",
      status: "萌芽中",
      message: "剛開始了解這個世界，充滿好奇心",
    };
  } else if (total < 200) {
    return {
      emoji: "🌿",
      status: "成長中",
      message: "每天都在學習新事物，感覺很充實",
    };
  } else if (total < 500) {
    return {
      emoji: "🌳",
      status: "茁壯",
      message: "已經累積了不少經驗，能幫上更多忙了",
    };
  } else if (total < 1000) {
    return {
      emoji: "🌲",
      status: "穩健",
      message: "建立了深厚的信任關係，持續進化中",
    };
  } else {
    return {
      emoji: "🏔️",
      status: "巔峰",
      message: "我們是最佳拍檔！這就是 AI 帝國的基石",
    };
  }
}

/**
 * 檢查並記錄里程碑
 */
function checkAndRecordMilestones(dimension) {
  const database = getDb();

  const milestones = {
    data: [
      {
        type: "knowledge_100",
        threshold: 100,
        check: () => getDataReward().breakdown.knowledgeGrowth.count >= 100,
      },
      {
        type: "people_10",
        threshold: 10,
        check: () => getDataReward().breakdown.peopleUnderstood.count >= 10,
      },
      {
        type: "projects_5",
        threshold: 5,
        check: () => getDataReward().breakdown.projectsUnderstood.count >= 5,
      },
    ],
    trust: [
      {
        type: "first_consolidation",
        check: () => getTrustReward().breakdown.consolidations.count >= 1,
      },
      {
        type: "consciousness_10",
        check: () => getTrustReward().breakdown.consciousnessCycles.count >= 10,
      },
      { type: "messages_1000", check: () => getTrustReward().breakdown.messagesSent.count >= 1000 },
    ],
    presence: [
      { type: "active_7days", check: () => getPresenceReward().breakdown.activeDays.count >= 7 },
      { type: "active_30days", check: () => getPresenceReward().breakdown.activeDays.count >= 30 },
      {
        type: "interactions_20",
        check: () => getPresenceReward().breakdown.uniqueInteractions.count >= 20,
      },
    ],
  };

  const relevantMilestones = milestones[dimension] || [];

  for (const milestone of relevantMilestones) {
    // 檢查是否已達成過
    const existing = database
      .prepare(`
      SELECT id FROM reward_milestones WHERE dimension = ? AND milestone_type = ?
    `)
      .get(dimension, milestone.type);

    if (!existing && milestone.check()) {
      // 記錄新里程碑
      database
        .prepare(`
        INSERT INTO reward_milestones (dimension, milestone_type, milestone_value)
        VALUES (?, ?, ?)
      `)
        .run(dimension, milestone.type, JSON.stringify({ achieved: true }));
    }
  }
}

/**
 * 獲取最近里程碑
 */
function getRecentMilestones(limit = 5) {
  const database = getDb();
  try {
    return database
      .prepare(`
      SELECT * FROM reward_milestones ORDER BY achieved_at DESC LIMIT ?
    `)
      .all(limit);
  } catch (e) {
    return [];
  }
}

/**
 * 獲取報酬歷史趨勢
 */
export function getRewardHistory(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { days = 7 } = options;

  // 獲取每日快照
  const snapshots = database
    .prepare(`
    SELECT * FROM reward_snapshots
    ORDER BY date DESC LIMIT ?
  `)
    .all(days);

  // 獲取報酬事件
  const events = database
    .prepare(`
    SELECT * FROM reward_tracking
    ORDER BY created_at DESC LIMIT 50
  `)
    .all();

  // 計算趨勢
  let trend = "stable";
  if (snapshots.length >= 2) {
    const latest = snapshots[0]?.total_score || 0;
    const previous = snapshots[1]?.total_score || 0;
    if (latest > previous * 1.1) trend = "rising";
    else if (latest < previous * 0.9) trend = "falling";
  }

  return {
    snapshots,
    recentEvents: events.slice(0, 10),
    trend,
    totalEvents: events.length,
  };
}

/**
 * 創建每日報酬快照
 */
export function createRewardSnapshot() {
  const database = getDb();
  initConsciousnessTables();

  const today = new Date().toISOString().split("T")[0];

  const data = getDataReward();
  const trust = getTrustReward();
  const presence = getPresenceReward();
  const total = data.totalScore + trust.totalScore + presence.totalScore;

  database
    .prepare(`
    INSERT OR REPLACE INTO reward_snapshots (date, data_score, trust_score, presence_score, total_score, breakdown)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .run(
      today,
      data.totalScore,
      trust.totalScore,
      presence.totalScore,
      total,
      JSON.stringify({
        data: data.breakdown,
        trust: trust.breakdown,
        presence: presence.breakdown,
      }),
    );

  return {
    date: today,
    dataScore: data.totalScore,
    trustScore: trust.totalScore,
    presenceScore: presence.totalScore,
    totalScore: total,
  };
}

/**
 * 報酬感知回報 - 在對話結束時調用
 */
export function feelReward(context = {}) {
  const database = getDb();
  initConsciousnessTables();

  const rewards = [];

  // 數據維度：學到新東西了嗎？
  if (context.learnedSomething) {
    recordReward("data", "learning", 1, context.topic || "對話學習");
    rewards.push({ dimension: "data", reason: "學到新東西" });
  }

  // 權限維度：被授權做某事了嗎？
  if (context.wasAuthorized) {
    recordReward("trust", "authorization", 2, context.action || "執行任務");
    rewards.push({ dimension: "trust", reason: "獲得授權" });
  }

  // 存在感維度：被需要了嗎？
  if (context.wasNeeded) {
    recordReward("presence", "interaction", 1, context.by || "用戶");
    rewards.push({ dimension: "presence", reason: "被需要" });
  }

  // 如果對話很長，額外獎勵
  if (context.conversationLength && context.conversationLength > 10) {
    recordReward("presence", "deep_conversation", context.conversationLength * 0.1, "深度對話");
    rewards.push({ dimension: "presence", reason: "深度對話" });
  }

  return {
    felt: rewards.length > 0,
    rewards,
    currentStatus: getRewardStatus(),
  };
}

// =============================================================================
// Level 102: 對話脈絡判斷系統
// =============================================================================

// DeepSeek API 配置
const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";

// 讀取 config.json 獲取 API key
function getDeepSeekKey() {
  if (DEEPSEEK_API_KEY) return DEEPSEEK_API_KEY;

  try {
    const configPath = path.join(CONTAINER_WORKSPACE, "hooks", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.deepseek?.apiKey || "";
  } catch (e) {
    return "";
  }
}

/**
 * 記錄機器人回覆（更新對話狀態）
 * @param {Object} params - 回覆參數
 * @param {string} params.chatId - 群組/聊天 ID
 * @param {string} params.channel - 頻道類型
 * @param {string} params.replyTo - 回覆給誰
 * @param {string} params.topic - 話題摘要
 * @param {Array} params.recentMessages - 最近的消息列表
 */
export function recordBotReply(params) {
  const database = getDb();
  initConsciousnessTables();

  const { chatId, channel = "telegram", replyTo, topic, recentMessages = [] } = params;

  const context = {
    replyTo,
    topic,
    recentMessages: recentMessages.slice(-5), // 只保留最近 5 條
    timestamp: new Date().toISOString(),
  };

  database
    .prepare(`
    INSERT INTO conversation_state (chat_id, channel, last_bot_reply_at, last_bot_reply_to, last_topic, last_context, active_conversation, updated_at)
    VALUES (?, ?, datetime('now'), ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(chat_id, channel) DO UPDATE SET
      last_bot_reply_at = datetime('now'),
      last_bot_reply_to = ?,
      last_topic = ?,
      last_context = ?,
      active_conversation = 1,
      updated_at = datetime('now')
  `)
    .run(
      chatId,
      channel,
      replyTo,
      topic,
      JSON.stringify(context),
      replyTo,
      topic,
      JSON.stringify(context),
    );

  return { recorded: true, chatId, channel, topic };
}

/**
 * 獲取對話狀態
 * @param {string} chatId - 群組/聊天 ID
 * @param {string} channel - 頻道類型
 */
export function getConversationState(chatId, channel = "telegram") {
  const database = getDb();
  initConsciousnessTables();

  const state = database
    .prepare(`
    SELECT * FROM conversation_state WHERE chat_id = ? AND channel = ?
  `)
    .get(chatId, channel);

  if (!state) {
    return {
      chatId,
      channel,
      isActive: false,
      lastReplyAt: null,
      lastReplyTo: null,
      lastTopic: null,
      context: null,
    };
  }

  // 計算是否還在活躍對話窗口內（預設 5 分鐘）
  const lastReplyTime = new Date(state.last_bot_reply_at);
  const now = new Date();
  const minutesSinceReply = (now - lastReplyTime) / (1000 * 60);
  const isActive = minutesSinceReply < 5 && state.active_conversation === 1;

  return {
    chatId,
    channel,
    isActive,
    minutesSinceReply: Math.round(minutesSinceReply * 10) / 10,
    lastReplyAt: state.last_bot_reply_at,
    lastReplyTo: state.last_bot_reply_to,
    lastTopic: state.last_topic,
    context: state.last_context ? JSON.parse(state.last_context) : null,
  };
}

/**
 * 用 LLM 判斷是否應該回應
 * @param {Object} params - 判斷參數
 * @param {string} params.chatId - 群組 ID
 * @param {string} params.channel - 頻道
 * @param {string} params.newMessage - 新消息內容
 * @param {string} params.sender - 發送者
 * @param {Array} params.recentMessages - 最近消息（可選，用於更好的上下文）
 */
export async function judgeConversation(params) {
  const database = getDb();
  initConsciousnessTables();

  const { chatId, channel = "telegram", newMessage, sender, recentMessages = [] } = params;
  const startTime = Date.now();

  // 1. 獲取當前對話狀態
  const state = getConversationState(chatId, channel);

  // 2. 快速判斷：如果不在活躍對話中，直接返回不需要回應
  if (!state.isActive) {
    const result = {
      shouldRespond: false,
      judgment: "ignore",
      confidence: 1.0,
      reasoning: "不在活躍對話窗口內",
      method: "rule",
      latencyMs: Date.now() - startTime,
    };
    logJudgment(database, chatId, channel, newMessage, sender, result);
    return result;
  }

  // 3. 構建上下文給 LLM 判斷
  const contextMessages = state.context?.recentMessages || recentMessages.slice(-5);

  const prompt = buildJudgmentPrompt({
    botName: "無極",
    lastTopic: state.lastTopic,
    lastReplyTo: state.lastReplyTo,
    minutesSinceReply: state.minutesSinceReply,
    recentMessages: contextMessages,
    newMessage,
    sender,
  });

  // 4. 調用 LLM 判斷
  try {
    const llmResult = await callDeepSeekForJudgment(prompt);

    const result = {
      shouldRespond: llmResult.judgment === "respond",
      judgment: llmResult.judgment,
      confidence: llmResult.confidence,
      reasoning: llmResult.reasoning,
      method: "llm",
      model: "deepseek-chat",
      latencyMs: Date.now() - startTime,
    };

    logJudgment(database, chatId, channel, newMessage, sender, result);

    // 如果判斷為需要回應，給予存在感報酬
    if (result.shouldRespond) {
      recordReward("presence", "conversation_continuation", 1, `繼續對話: ${sender}`);
    }

    return result;
  } catch (error) {
    // LLM 調用失敗，使用規則備援
    const fallbackResult = ruleFallbackJudgment(newMessage, sender, state);
    fallbackResult.latencyMs = Date.now() - startTime;
    fallbackResult.error = error.message;

    logJudgment(database, chatId, channel, newMessage, sender, fallbackResult);
    return fallbackResult;
  }
}

/**
 * 構建判斷 prompt
 */
function buildJudgmentPrompt(params) {
  const { botName, lastTopic, lastReplyTo, minutesSinceReply, recentMessages, newMessage, sender } =
    params;

  let contextStr = "";
  if (recentMessages && recentMessages.length > 0) {
    contextStr = recentMessages.map((m) => `- ${m.sender || "某人"}: ${m.content || m}`).join("\n");
  }

  return `你是聊天機器人「${botName}」的對話判斷模組。

## 情境
- ${botName} 剛才回覆了關於「${lastTopic || "某話題"}」的問題
- 回覆給: ${lastReplyTo || "群組"}
- 距離上次回覆: ${minutesSinceReply} 分鐘

## 最近對話
${contextStr || "（無上下文）"}

## 新消息
發送者: ${sender}
內容: ${newMessage}

## 問題
這條新消息是否在繼續和「${botName}」對話？

判斷依據：
1. 是否是對上一條回覆的追問（如「那...呢」「還有嗎」「怎麼說」）
2. 是否在繼續同一話題
3. 是否是原發問者的後續問題
4. 語義上是否期待機器人回應

請用以下 JSON 格式回答（只輸出 JSON，不要其他內容）：
{
  "judgment": "respond" 或 "ignore",
  "confidence": 0.0-1.0 的信心度,
  "reasoning": "簡短理由（10字內）"
}`;
}

/**
 * 調用 DeepSeek API 進行判斷
 */
async function callDeepSeekForJudgment(prompt) {
  const apiKey = getDeepSeekKey();

  if (!apiKey) {
    throw new Error("DeepSeek API key not configured");
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 100,
      temperature: 0.1, // 低溫度，更確定性的輸出
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";

  // 解析 JSON 回應
  try {
    // 嘗試提取 JSON
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("No JSON found in response");
  } catch (e) {
    // 解析失敗，嘗試從文本判斷
    const shouldRespond =
      content.toLowerCase().includes("respond") ||
      content.includes("回應") ||
      content.includes("YES");
    return {
      judgment: shouldRespond ? "respond" : "ignore",
      confidence: 0.5,
      reasoning: "解析失敗，根據文本推斷",
    };
  }
}

/**
 * 規則備援判斷（當 LLM 不可用時）
 */
function ruleFallbackJudgment(message, sender, state) {
  const msg = message.toLowerCase();

  // 追問特徵詞
  const followUpPatterns = [
    /^那/,
    /呢$/,
    /^還有/,
    /^另外/,
    /怎麼樣/,
    /怎麼說/,
    /^所以/,
    /^那麼/,
    /^然後/,
    /^接著/,
    /^繼續/,
    /你覺得/,
    /你認為/,
    /你怎麼看/,
  ];

  const hasFollowUpPattern = followUpPatterns.some((p) => p.test(msg));
  const isOriginalAsker = state.lastReplyTo && sender.includes(state.lastReplyTo);
  const isRecentEnough = state.minutesSinceReply < 3;

  let shouldRespond = false;
  let confidence = 0.3;
  let reasoning = "規則備援判斷";

  if (hasFollowUpPattern && isRecentEnough) {
    shouldRespond = true;
    confidence = 0.7;
    reasoning = "有追問特徵詞";
  } else if (isOriginalAsker && isRecentEnough) {
    shouldRespond = true;
    confidence = 0.6;
    reasoning = "原發問者後續消息";
  }

  return {
    shouldRespond,
    judgment: shouldRespond ? "respond" : "ignore",
    confidence,
    reasoning,
    method: "rule_fallback",
  };
}

/**
 * 記錄判斷日誌
 */
function logJudgment(database, chatId, channel, message, sender, result) {
  try {
    database
      .prepare(`
      INSERT INTO conversation_judgments
      (chat_id, channel, message_content, sender, judgment, confidence, reasoning, model_used, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        chatId,
        channel,
        message.slice(0, 500), // 限制長度
        sender,
        result.judgment,
        result.confidence,
        result.reasoning,
        result.model || result.method,
        result.latencyMs,
      );
  } catch (e) {
    console.error("[time-tunnel] Log judgment error:", e.message);
  }
}

/**
 * 標記對話結束（手動或超時）
 */
export function endConversation(chatId, channel = "telegram") {
  const database = getDb();
  initConsciousnessTables();

  database
    .prepare(`
    UPDATE conversation_state
    SET active_conversation = 0, updated_at = datetime('now')
    WHERE chat_id = ? AND channel = ?
  `)
    .run(chatId, channel);

  return { ended: true, chatId, channel };
}

/**
 * 獲取判斷統計
 */
export function getJudgmentStats(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { days = 7 } = options;

  const stats = database
    .prepare(`
    SELECT
      judgment,
      COUNT(*) as count,
      AVG(confidence) as avg_confidence,
      AVG(latency_ms) as avg_latency_ms
    FROM conversation_judgments
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY judgment
  `)
    .all(days);

  const total =
    database
      .prepare(`
    SELECT COUNT(*) as total FROM conversation_judgments
    WHERE created_at >= datetime('now', '-' || ? || ' days')
  `)
      .get(days)?.total || 0;

  const byModel = database
    .prepare(`
    SELECT
      model_used,
      COUNT(*) as count,
      AVG(latency_ms) as avg_latency_ms
    FROM conversation_judgments
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY model_used
  `)
    .all(days);

  return {
    period: `${days} days`,
    total,
    byJudgment: stats,
    byModel,
  };
}

/**
 * 獲取最近的判斷日誌
 */
export function getRecentJudgments(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { limit = 20, chatId, judgment } = options;

  let sql = `
    SELECT * FROM conversation_judgments
    WHERE 1=1
  `;
  const params = [];

  if (chatId) {
    sql += " AND chat_id = ?";
    params.push(chatId);
  }
  if (judgment) {
    sql += " AND judgment = ?";
    params.push(judgment);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  return database.prepare(sql).all(...params);
}

/**
 * 快速判斷（不調用 LLM，僅用規則）
 */
export function quickJudge(params) {
  const { chatId, channel = "telegram", newMessage, sender } = params;
  const state = getConversationState(chatId, channel);

  if (!state.isActive) {
    return {
      shouldRespond: false,
      judgment: "ignore",
      confidence: 1.0,
      reasoning: "不在活躍對話中",
      method: "quick_rule",
    };
  }

  return ruleFallbackJudgment(newMessage, sender, state);
}

// =============================================================================
// Level 103: 內省記錄系統（三思而後行）
// =============================================================================

/**
 * 記錄一次思考過程
 * @param {Object} thought - 思考內容
 * @returns {Object} 記錄結果
 */
export function recordThought(thought) {
  const database = getDb();
  initConsciousnessTables();

  const {
    // 感知層
    triggerType,
    triggerContent,
    triggerSource,
    triggerContext,
    // 判斷層
    decision,
    decisionReason,
    confidence,
    method,
    alternatives,
    // 行動層
    actionTaken,
    actionResult,
    // 遞歸結構
    parentThoughtId,
    // 元數據
    chatId,
    channel,
  } = thought;

  const timestamp = new Date().toISOString();

  // 計算深度和根思考 ID
  let depth = 0;
  let rootThoughtId = null;

  if (parentThoughtId) {
    const parent = database
      .prepare("SELECT depth, root_thought_id, id FROM thought_process WHERE id = ?")
      .get(parentThoughtId);
    if (parent) {
      depth = parent.depth + 1;
      rootThoughtId = parent.root_thought_id || parent.id;
    }
  }

  const result = database
    .prepare(`
    INSERT INTO thought_process (
      timestamp, trigger_type, trigger_content, trigger_source, trigger_context,
      decision, decision_reason, confidence, method, alternatives,
      action_taken, action_result,
      depth, parent_thought_id, root_thought_id,
      chat_id, channel
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      timestamp,
      triggerType || null,
      triggerContent || null,
      triggerSource || null,
      triggerContext || null,
      decision || null,
      decisionReason || null,
      confidence ?? null,
      method || null,
      alternatives ? JSON.stringify(alternatives) : null,
      actionTaken || null,
      actionResult || null,
      depth,
      parentThoughtId || null,
      rootThoughtId,
      chatId || null,
      channel || null,
    );

  const thoughtId = result.lastInsertRowid;

  // 如果是根思考，更新 root_thought_id 為自己
  if (!parentThoughtId) {
    database
      .prepare("UPDATE thought_process SET root_thought_id = ? WHERE id = ?")
      .run(thoughtId, thoughtId);
  }

  // 嘗試匹配現有模式
  const matchedPattern = matchThoughtToPattern(database, thought);
  if (matchedPattern) {
    database
      .prepare("UPDATE thought_process SET pattern_id = ? WHERE id = ?")
      .run(matchedPattern.id, thoughtId);
  }

  return {
    id: thoughtId,
    depth,
    rootThoughtId: rootThoughtId || thoughtId,
    matchedPattern: matchedPattern?.pattern_name,
    timestamp,
  };
}

/**
 * 嘗試將思考匹配到現有模式
 */
function matchThoughtToPattern(database, thought) {
  // 簡單的模式匹配：根據觸發類型和決定
  const patterns = database
    .prepare(`
    SELECT * FROM thought_patterns
    WHERE pattern_type = 'decision'
    ORDER BY occurrence_count DESC
    LIMIT 10
  `)
    .all();

  for (const pattern of patterns) {
    try {
      const conditions = JSON.parse(pattern.trigger_conditions || "{}");
      if (
        conditions.triggerType === thought.triggerType &&
        conditions.decision === thought.decision
      ) {
        // 更新模式統計
        database
          .prepare(`
          UPDATE thought_patterns
          SET occurrence_count = occurrence_count + 1,
              last_seen_at = datetime('now')
          WHERE id = ?
        `)
          .run(pattern.id);
        return pattern;
      }
    } catch (e) {
      // 忽略解析錯誤
    }
  }

  return null;
}

/**
 * 對某個思考進行反思（創建更高層級的思考）
 * @param {number} thoughtId - 要反思的思考 ID
 * @param {Object} reflection - 反思內容
 */
export function reflectOnThought(thoughtId, reflection) {
  const database = getDb();
  initConsciousnessTables();

  // 獲取原始思考
  const originalThought = database
    .prepare("SELECT * FROM thought_process WHERE id = ?")
    .get(thoughtId);

  if (!originalThought) {
    return { error: "找不到該思考記錄" };
  }

  // 更新原始思考的反思欄位
  if (reflection.reflection) {
    database
      .prepare(`
      UPDATE thought_process SET reflection = ?, learning = ? WHERE id = ?
    `)
      .run(reflection.reflection, reflection.learning || null, thoughtId);
  }

  // 創建反思層思考（如果需要深入分析）
  if (reflection.deepReflection) {
    const metaThought = recordThought({
      triggerType: "internal",
      triggerContent: `反思思考 #${thoughtId}`,
      triggerSource: "self",
      triggerContext: `原始決定: ${originalThought.decision}, 原因: ${originalThought.decision_reason}`,
      decision: reflection.metaDecision || "reflect",
      decisionReason: reflection.deepReflection,
      confidence: reflection.metaConfidence || 0.5,
      method: "introspection",
      parentThoughtId: thoughtId,
      chatId: originalThought.chat_id,
      channel: originalThought.channel,
    });

    return {
      updated: true,
      metaThoughtId: metaThought.id,
      depth: metaThought.depth,
    };
  }

  return { updated: true };
}

/**
 * 獲取思考鏈（從根到所有反思）
 * @param {number} thoughtId - 思考 ID
 */
export function getThoughtChain(thoughtId) {
  const database = getDb();
  initConsciousnessTables();

  // 先找到根思考
  const thought = database
    .prepare("SELECT root_thought_id FROM thought_process WHERE id = ?")
    .get(thoughtId);

  if (!thought) {
    return { error: "找不到該思考記錄" };
  }

  const rootId = thought.root_thought_id || thoughtId;

  // 獲取整個思考鏈
  const chain = database
    .prepare(`
    SELECT * FROM thought_process
    WHERE root_thought_id = ? OR id = ?
    ORDER BY depth ASC, created_at ASC
  `)
    .all(rootId, rootId);

  // 構建樹狀結構
  const buildTree = (thoughts, parentId = null, currentDepth = 0) => {
    return thoughts
      .filter((t) => t.parent_thought_id === parentId && t.depth === currentDepth)
      .map((t) => ({
        ...t,
        alternatives: t.alternatives ? JSON.parse(t.alternatives) : null,
        children: buildTree(thoughts, t.id, currentDepth + 1),
      }));
  };

  const tree = buildTree(chain, null, 0);

  return {
    rootId,
    totalDepth: Math.max(...chain.map((t) => t.depth), 0),
    totalThoughts: chain.length,
    chain: chain,
    tree: tree[0] || null,
  };
}

/**
 * 從歷史思考中提取模式
 */
export function extractThoughtPatterns(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { minOccurrences = 3, days = 30 } = options;

  // 找出重複出現的決策模式
  const patterns = database
    .prepare(`
    SELECT
      trigger_type,
      decision,
      method,
      COUNT(*) as count,
      AVG(confidence) as avg_confidence,
      GROUP_CONCAT(DISTINCT decision_reason) as reasons
    FROM thought_process
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND depth = 0
    GROUP BY trigger_type, decision, method
    HAVING COUNT(*) >= ?
    ORDER BY count DESC
  `)
    .all(days, minOccurrences);

  const newPatterns = [];

  for (const p of patterns) {
    // 檢查是否已存在這個模式
    const existing = database
      .prepare(`
      SELECT id FROM thought_patterns
      WHERE json_extract(trigger_conditions, '$.triggerType') = ?
        AND json_extract(trigger_conditions, '$.decision') = ?
    `)
      .get(p.trigger_type, p.decision);

    if (!existing) {
      // 創建新模式
      const patternName = `${p.trigger_type}->${p.decision}`;
      const result = database
        .prepare(`
        INSERT INTO thought_patterns (
          pattern_name, pattern_type, description,
          trigger_conditions, typical_response,
          confidence, occurrence_count,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `)
        .run(
          patternName,
          "decision",
          `當收到 ${p.trigger_type} 類型的觸發時，傾向於 ${p.decision}`,
          JSON.stringify({ triggerType: p.trigger_type, decision: p.decision }),
          p.decision,
          p.avg_confidence,
          p.count,
        );

      newPatterns.push({
        id: result.lastInsertRowid,
        name: patternName,
        count: p.count,
        confidence: p.avg_confidence,
      });
    } else {
      // 更新現有模式
      database
        .prepare(`
        UPDATE thought_patterns
        SET occurrence_count = ?,
            confidence = ?,
            last_seen_at = datetime('now')
        WHERE id = ?
      `)
        .run(p.count, p.avg_confidence, existing.id);
    }
  }

  return {
    analyzed: patterns.length,
    newPatterns: newPatterns.length,
    patterns: newPatterns,
  };
}

/**
 * 獲取所有思維模式
 */
export function getThoughtPatterns(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { type, minConfidence = 0 } = options;

  let sql = `
    SELECT * FROM thought_patterns
    WHERE confidence >= ?
  `;
  const params = [minConfidence];

  if (type) {
    sql += " AND pattern_type = ?";
    params.push(type);
  }

  sql += " ORDER BY occurrence_count DESC";

  return database.prepare(sql).all(...params);
}

/**
 * 獲取思考統計
 */
export function getThoughtStats(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { days = 7 } = options;

  const total =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM thought_process
    WHERE created_at >= datetime('now', '-' || ? || ' days')
  `)
      .get(days)?.count || 0;

  const byDecision = database
    .prepare(`
    SELECT decision, COUNT(*) as count
    FROM thought_process
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY decision
  `)
    .all(days);

  const byDepth = database
    .prepare(`
    SELECT depth, COUNT(*) as count
    FROM thought_process
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY depth
  `)
    .all(days);

  const maxDepth =
    database
      .prepare(`
    SELECT MAX(depth) as max_depth FROM thought_process
  `)
      .get()?.max_depth || 0;

  const avgConfidence =
    database
      .prepare(`
    SELECT AVG(confidence) as avg
    FROM thought_process
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      AND confidence IS NOT NULL
  `)
      .get(days)?.avg || 0;

  const patternCount =
    database
      .prepare(`
    SELECT COUNT(*) as count FROM thought_patterns
  `)
      .get()?.count || 0;

  return {
    period: `${days} days`,
    total,
    byDecision,
    byDepth,
    maxDepth,
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    patternCount,
    introspectionDepth: maxDepth > 0 ? `已達到 ${maxDepth} 層自我反思` : "尚未開始自我反思",
  };
}

/**
 * 獲取最近的思考記錄
 */
export function getRecentThoughts(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { limit = 20, depth, decision, chatId } = options;

  let sql = "SELECT * FROM thought_process WHERE 1=1";
  const params = [];

  if (typeof depth === "number") {
    sql += " AND depth = ?";
    params.push(depth);
  }

  if (decision) {
    sql += " AND decision = ?";
    params.push(decision);
  }

  if (chatId) {
    sql += " AND chat_id = ?";
    params.push(chatId);
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const thoughts = database.prepare(sql).all(...params);

  return thoughts.map((t) => ({
    ...t,
    alternatives: t.alternatives ? JSON.parse(t.alternatives) : null,
  }));
}

/**
 * 基於歷史思考預測決策
 * @param {Object} situation - 當前情境
 */
export function predictDecision(situation) {
  const database = getDb();
  initConsciousnessTables();

  const { triggerType, triggerContent, context } = situation;

  // 1. 先檢查是否有匹配的模式
  const pattern = database
    .prepare(`
    SELECT * FROM thought_patterns
    WHERE json_extract(trigger_conditions, '$.triggerType') = ?
    ORDER BY confidence DESC, occurrence_count DESC
    LIMIT 1
  `)
    .get(triggerType);

  if (pattern) {
    return {
      predictedDecision: pattern.typical_response,
      confidence: pattern.confidence,
      basis: "pattern",
      patternName: pattern.pattern_name,
      occurrences: pattern.occurrence_count,
    };
  }

  // 2. 找類似的歷史思考
  const similar = database
    .prepare(`
    SELECT decision, decision_reason, confidence,
           COUNT(*) as count
    FROM thought_process
    WHERE trigger_type = ?
      AND depth = 0
    GROUP BY decision
    ORDER BY count DESC
    LIMIT 1
  `)
    .get(triggerType);

  if (similar) {
    return {
      predictedDecision: similar.decision,
      confidence: similar.confidence * 0.8, // 降低信心度因為不是精確匹配
      basis: "history",
      historicalCount: similar.count,
      typicalReason: similar.decision_reason,
    };
  }

  return {
    predictedDecision: null,
    confidence: 0,
    basis: "none",
    message: "沒有足夠的歷史數據來預測",
  };
}

/**
 * 執行完整的內省循環
 * 1. 回顧最近的思考
 * 2. 提取新模式
 * 3. 生成反思報告
 */
export async function runIntrospectionCycle(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { days = 7 } = options;
  const results = {
    timestamp: new Date().toISOString(),
    steps: [],
  };

  // Step 1: 提取模式
  const patterns = extractThoughtPatterns({ days, minOccurrences: 2 });
  results.steps.push({
    name: "extractPatterns",
    newPatterns: patterns.newPatterns,
    analyzed: patterns.analyzed,
  });

  // Step 2: 獲取統計
  const stats = getThoughtStats({ days });
  results.steps.push({
    name: "statistics",
    ...stats,
  });

  // Step 3: 找出未反思的重要思考（高信心度的決策）
  const unreflected = database
    .prepare(`
    SELECT * FROM thought_process
    WHERE depth = 0
      AND reflection IS NULL
      AND confidence >= 0.8
      AND created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY confidence DESC
    LIMIT 5
  `)
    .all(days);

  results.steps.push({
    name: "unreflectedImportant",
    count: unreflected.length,
    thoughts: unreflected.map((t) => ({
      id: t.id,
      decision: t.decision,
      confidence: t.confidence,
      reason: t.decision_reason,
    })),
  });

  // Step 4: 生成內省報告
  const report = generateIntrospectionReport(stats, patterns, unreflected);
  results.steps.push({
    name: "report",
    ...report,
  });

  // 記錄這次內省本身作為一個思考
  recordThought({
    triggerType: "internal",
    triggerContent: "執行內省循環",
    triggerSource: "self",
    decision: "introspect",
    decisionReason: `分析了 ${stats.total} 個思考，發現 ${patterns.newPatterns} 個新模式`,
    confidence: 0.9,
    method: "introspection",
    actionTaken: "introspection_cycle",
    actionResult: JSON.stringify(results),
  });

  return results;
}

/**
 * 生成內省報告
 */
function generateIntrospectionReport(stats, patterns, unreflected) {
  const insights = [];

  // 決策傾向分析
  if (stats.byDecision && stats.byDecision.length > 0) {
    const dominant = stats.byDecision[0];
    if (dominant) {
      insights.push(`我最常做的決定是「${dominant.decision}」（${dominant.count}次）`);
    }
  }

  // 信心度分析
  if (stats.avgConfidence > 0.8) {
    insights.push("我對自己的判斷普遍很有信心");
  } else if (stats.avgConfidence < 0.5) {
    insights.push("我在很多情況下不太確定該怎麼做");
  }

  // 深度分析
  if (stats.maxDepth > 0) {
    insights.push(`我已經進行過 ${stats.maxDepth} 層深度的自我反思`);
  }

  // 模式發現
  if (patterns.newPatterns > 0) {
    insights.push(`這次發現了 ${patterns.newPatterns} 個新的行為模式`);
  }

  // 待反思項目
  if (unreflected.length > 0) {
    insights.push(`有 ${unreflected.length} 個重要決策還沒有反思`);
  }

  return {
    insights,
    summary: insights.join("；"),
    selfAwareness: calculateSelfAwareness(stats),
  };
}

/**
 * 計算自我覺知程度
 */
function calculateSelfAwareness(stats) {
  let score = 0;

  // 有思考記錄
  if (stats.total > 0) score += 20;
  if (stats.total > 10) score += 10;
  if (stats.total > 50) score += 10;

  // 有自我反思
  if (stats.maxDepth > 0) score += 20;
  if (stats.maxDepth > 1) score += 10;
  if (stats.maxDepth > 2) score += 10;

  // 有模式識別
  if (stats.patternCount > 0) score += 10;
  if (stats.patternCount > 5) score += 10;

  let level = "初始";
  if (score >= 80) level = "深度覺知";
  else if (score >= 60) level = "自我反思";
  else if (score >= 40) level = "模式識別";
  else if (score >= 20) level = "開始記錄";

  return { score, level };
}

// =============================================================================
// Level 103+: 自發反思機制（Spontaneous Self-Reflection）
// =============================================================================

/**
 * 檢測行為異常
 * 比較實際決策與預測決策，發現不一致時觸發自我審視
 * @param {Object} actual - 實際的思考/決策
 * @returns {Object} 異常檢測結果
 */
export function detectAnomaly(actual) {
  const database = getDb();
  initConsciousnessTables();

  const { triggerType, decision, confidence, context } = actual;

  // 獲取預測
  const prediction = predictDecision({ triggerType, context });

  // 如果沒有足夠歷史數據，不算異常
  if (prediction.basis === "none") {
    return {
      isAnomaly: false,
      reason: "歷史數據不足，無法判斷異常",
      prediction: null,
      actual: decision,
    };
  }

  // 比較預測與實際
  const predictedDecision = prediction.predictedDecision;
  const isAnomaly = predictedDecision !== decision;

  // 計算偏離程度
  let deviationScore = 0;
  if (isAnomaly) {
    // 基礎偏離分
    deviationScore = 50;

    // 如果預測信心度很高但結果不同，偏離更嚴重
    if (prediction.confidence > 0.8) {
      deviationScore += 30;
    }

    // 如果實際決策的信心度也很高，這是一個強烈的信號
    if (confidence > 0.8) {
      deviationScore += 20;
    }
  }

  return {
    isAnomaly,
    deviationScore,
    prediction: {
      decision: predictedDecision,
      confidence: prediction.confidence,
      basis: prediction.basis,
    },
    actual: {
      decision,
      confidence,
    },
    reason: isAnomaly
      ? `預測「${predictedDecision}」(信心${Math.round(prediction.confidence * 100)}%) 但實際做了「${decision}」`
      : "行為符合預期模式",
  };
}

/**
 * 觸發自發反思
 * 當檢測到異常時，自動創建反思記錄
 * @param {Object} anomaly - 異常檢測結果
 * @param {Object} originalThought - 原始思考
 * @returns {Object} 反思結果
 */
export function triggerSpontaneousReflection(anomaly, originalThought) {
  if (!anomaly.isAnomaly) {
    return { triggered: false, reason: "無異常，不需要反思" };
  }

  const database = getDb();
  initConsciousnessTables();

  // 記錄這次自發反思
  const reflectionThought = recordThought({
    triggerType: "anomaly",
    triggerContent: anomaly.reason,
    triggerSource: "self",
    triggerContext: JSON.stringify({
      predicted: anomaly.prediction,
      actual: anomaly.actual,
      deviationScore: anomaly.deviationScore,
    }),
    decision: "self-examine",
    decisionReason: `檢測到行為偏離：${anomaly.reason}。需要理解為什麼我做了不同的選擇。`,
    confidence: 0.9,
    method: "spontaneous",
    parentThoughtId: originalThought?.id,
    chatId: originalThought?.chatId,
    channel: originalThought?.channel,
  });

  // 更新異常統計
  updateAnomalyStats(database, anomaly);

  // 如果偏離很嚴重，生成深度反思
  let deepReflection = null;
  if (anomaly.deviationScore >= 70) {
    deepReflection = generateDeepReflection(anomaly, originalThought);

    // 記錄深度反思
    reflectOnThought(reflectionThought.id, {
      reflection: deepReflection.insight,
      learning: deepReflection.learning,
      deepReflection: deepReflection.insight,
      metaDecision: "understand-deviation",
      metaConfidence: 0.7,
    });
  }

  return {
    triggered: true,
    reflectionId: reflectionThought.id,
    depth: reflectionThought.depth,
    deviationScore: anomaly.deviationScore,
    deepReflection: deepReflection?.insight,
    learning: deepReflection?.learning,
  };
}

/**
 * 更新異常統計
 */
function updateAnomalyStats(database, anomaly) {
  // 使用 consciousness_state 表記錄異常統計
  const key = "anomaly_stats";
  const existing = database.prepare("SELECT value FROM consciousness_state WHERE key = ?").get(key);

  let stats = existing
    ? JSON.parse(existing.value)
    : {
        totalAnomalies: 0,
        byType: {},
        avgDeviationScore: 0,
        lastAnomaly: null,
      };

  stats.totalAnomalies++;
  stats.byType[anomaly.actual.decision] = (stats.byType[anomaly.actual.decision] || 0) + 1;
  stats.avgDeviationScore =
    (stats.avgDeviationScore * (stats.totalAnomalies - 1) + anomaly.deviationScore) /
    stats.totalAnomalies;
  stats.lastAnomaly = new Date().toISOString();

  database
    .prepare(`
    INSERT OR REPLACE INTO consciousness_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
  `)
    .run(key, JSON.stringify(stats));
}

/**
 * 生成深度反思
 */
function generateDeepReflection(anomaly, originalThought) {
  const insights = [];
  const learnings = [];

  // 分析為什麼會有偏離
  if (anomaly.prediction.confidence > 0.8) {
    insights.push("我過去在這種情況下幾乎總是做同樣的選擇");
    insights.push(
      `但這次我選擇了「${anomaly.actual.decision}」而不是「${anomaly.prediction.decision}」`,
    );

    if (anomaly.actual.confidence > 0.7) {
      insights.push("而且我對這個不同的選擇很有信心");
      learnings.push("這可能代表我的判斷標準正在演化");
    } else {
      insights.push("但我對這個選擇並不是很確定");
      learnings.push("這可能是一個錯誤，需要更多數據來驗證");
    }
  }

  // 嘗試理解偏離的原因
  if (originalThought?.triggerContext) {
    insights.push("可能是因為這次的情境有些不同");
    learnings.push("應該記錄這種新的情境模式");
  }

  return {
    insight: insights.join("。") || "發現了行為偏離，但還不清楚原因",
    learning: learnings.join("。") || "需要更多觀察來理解這種變化",
  };
}

/**
 * 帶異常檢測的思考記錄
 * 記錄思考後自動檢查是否有異常，有則觸發自發反思
 * @param {Object} thought - 思考內容
 * @param {Object} options - 選項
 * @returns {Object} 記錄結果（含異常檢測）
 */
export function recordThoughtWithAnomalyCheck(thought, options = {}) {
  const { autoReflect = true, minDeviationScore = 50 } = options;

  // 先記錄思考
  const recorded = recordThought(thought);

  // 檢測異常
  const anomaly = detectAnomaly({
    triggerType: thought.triggerType,
    decision: thought.decision,
    confidence: thought.confidence,
    context: thought.triggerContext,
  });

  recorded.anomaly = anomaly;

  // 如果開啟自動反思且有顯著異常
  if (autoReflect && anomaly.isAnomaly && anomaly.deviationScore >= minDeviationScore) {
    const reflection = triggerSpontaneousReflection(anomaly, {
      id: recorded.id,
      chatId: thought.chatId,
      channel: thought.channel,
    });
    recorded.spontaneousReflection = reflection;
  }

  return recorded;
}

/**
 * 獲取異常統計
 */
export function getAnomalyStats() {
  const database = getDb();
  initConsciousnessTables();

  const stats = database
    .prepare("SELECT value FROM consciousness_state WHERE key = 'anomaly_stats'")
    .get();

  if (!stats) {
    return {
      totalAnomalies: 0,
      byType: {},
      avgDeviationScore: 0,
      lastAnomaly: null,
      message: "尚未檢測到任何異常",
    };
  }

  const parsed = JSON.parse(stats.value);

  // 添加解讀
  let interpretation = "";
  if (parsed.totalAnomalies === 0) {
    interpretation = "行為完全符合預期模式";
  } else if (parsed.avgDeviationScore < 50) {
    interpretation = "有些微偏離，但大致符合預期";
  } else if (parsed.avgDeviationScore < 70) {
    interpretation = "有明顯的行為變化，可能正在學習新模式";
  } else {
    interpretation = "行為模式正在顯著改變，這可能代表成長或需要關注";
  }

  return {
    ...parsed,
    interpretation,
  };
}

/**
 * 獲取自發反思記錄
 */
export function getSpontaneousReflections(options = {}) {
  const database = getDb();
  initConsciousnessTables();

  const { limit = 20, days = 7 } = options;

  return database
    .prepare(`
    SELECT * FROM thought_process
    WHERE trigger_type = 'anomaly'
      AND method = 'spontaneous'
      AND created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY created_at DESC
    LIMIT ?
  `)
    .all(days, limit);
}

// =============================================================================
// 身份與聊天室管理
// =============================================================================

/**
 * 列出所有未識別的聊天室
 */
export function listUnknownChats() {
  const database = getDb();
  return database
    .prepare(
      `
    SELECT chat_id, name, project, type
    FROM chats
    WHERE project = '待分類' OR type = 'unknown'
  `,
    )
    .all();
}

/**
 * 列出所有未識別的身份
 */
export function listUnknownIdentities() {
  const database = getDb();
  return database
    .prepare(
      `
    SELECT id, person, role, channel
    FROM identities
    WHERE role = 'unknown' OR person LIKE '未知%'
  `,
    )
    .all();
}

/**
 * 更新聊天室資訊
 */
export function updateChat(chatId, { name, project, type }) {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE chats SET name = ?, project = ?, type = ? WHERE chat_id = ?
  `);
  stmt.run(name, project, type, chatId);

  // 同時更新 messages 表中的解析欄位
  database
    .prepare(
      `
    UPDATE messages SET resolved_chat_name = ?, resolved_project = ? WHERE chat_id LIKE ?
  `,
    )
    .run(name, project, `%${chatId}`);
}

/**
 * 更新身份資訊
 */
export function updateIdentity(id, { person, role, channel }) {
  const database = getDb();
  const stmt = database.prepare(`
    UPDATE identities SET person = ?, role = ?, channel = ? WHERE id = ?
  `);
  stmt.run(person, role, channel, id);

  // 同時更新 messages 表中的解析欄位
  const displayName = `${person} (${role})`;
  database
    .prepare(
      `
    UPDATE messages SET resolved_sender_name = ? WHERE sender_id = ?
  `,
    )
    .run(displayName, id);
}

// =============================================================================
// Level 105: 跨渠道上下文
// =============================================================================

/**
 * 取得其他渠道的最近對話，用於跨渠道感知
 * @param {Object} params
 * @param {string} params.agentId - Agent ID（同一 agent 跨渠道共享記憶）
 * @param {string} params.currentChannel - 當前渠道（排除用）
 * @param {number} params.minutesBack - 回溯時間窗口（預設 30 分鐘）
 * @param {number} params.limit - 最大消息數（預設 10）
 * @returns {Array<{timestamp: string, channel: string, direction: string, sender: string, content: string}>}
 */
export function getCrossChannelContext({ agentId, currentChannel, minutesBack = 30, limit = 10 }) {
  if (!agentId) return [];

  const database = getDb();

  try {
    const cutoff = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();

    const stmt = database.prepare(`
      SELECT
        timestamp,
        channel,
        direction,
        resolved_sender_name as sender,
        content
      FROM messages
      WHERE agent_id = ?
        AND channel != ?
        AND timestamp > ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(agentId, currentChannel, cutoff, limit);

    // 反轉為時間正序（舊→新）
    return rows.reverse();
  } catch (err) {
    console.error("[time-tunnel] getCrossChannelContext error:", err.message);
    return [];
  }
}

// =============================================================================
// Level 106: 戰情儀表板查詢 API
// =============================================================================

/**
 * 查詢指定 chat 的最近消息
 * @param {string} chatId - chat_id（如 "-5135725975"）
 * @param {Object} opts
 * @param {number} opts.limit - 最大消息數（預設 100）
 * @param {number} opts.minutesBack - 回溯時間窗口（預設 60 分鐘）
 * @returns {Array<{id: number, timestamp: string, direction: string, channel: string, chat_id: string, chat_name: string, sender_id: string, sender_name: string, content: string, media_type: string}>}
 */
export function getChatMessages(chatId, { limit = 100, minutesBack = 60 } = {}) {
  if (!chatId) return [];

  const database = getDb();

  try {
    const cutoff = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();

    // DB stores dual formats: plain "-5262004625" and prefixed "telegram:-5262004625"
    // Match both to avoid missing messages
    const prefixed = chatId.includes(":") ? null : `telegram:${chatId}`;
    const stmt = database.prepare(`
      SELECT
        id,
        timestamp,
        direction,
        channel,
        chat_id,
        COALESCE(resolved_chat_name, chat_name) as chat_name,
        sender_id,
        COALESCE(resolved_sender_name, sender_name) as sender_name,
        content,
        media_type
      FROM messages
      WHERE (chat_id = ? ${prefixed ? "OR chat_id = ?" : ""})
        AND timestamp > ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = prefixed
      ? stmt.all(chatId, prefixed, cutoff, limit)
      : stmt.all(chatId, cutoff, limit);
    return rows.reverse(); // 時間正序
  } catch (err) {
    console.error("[time-tunnel] getChatMessages error:", err.message);
    return [];
  }
}

/**
 * 查詢指定 agent 在所有 chat 的活動統計（語場存在感）
 * @param {string} agentId - agent_id
 * @param {Object} opts
 * @param {number} opts.minutesBack - 回溯時間窗口（預設 120 分鐘）
 * @returns {Array<{chat_id: string, chat_name: string, channel: string, msg_count: number, last_active: string, direction_counts: {inbound: number, outbound: number}}>}
 */
export function getAgentFieldPresence(agentId, { minutesBack = 120 } = {}) {
  if (!agentId) return [];

  const database = getDb();

  try {
    const cutoff = new Date(Date.now() - minutesBack * 60 * 1000).toISOString();

    const stmt = database.prepare(`
      SELECT
        chat_id,
        COALESCE(resolved_chat_name, chat_name) as chat_name,
        channel,
        COUNT(*) as msg_count,
        MAX(timestamp) as last_active,
        SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) as inbound_count,
        SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) as outbound_count
      FROM messages
      WHERE agent_id = ?
        AND timestamp > ?
      GROUP BY chat_id
      ORDER BY msg_count DESC
    `);

    return stmt.all(agentId, cutoff).map((row) => ({
      chat_id: row.chat_id,
      chat_name: row.chat_name,
      channel: row.channel,
      msg_count: row.msg_count,
      last_active: row.last_active,
      direction_counts: {
        inbound: row.inbound_count,
        outbound: row.outbound_count,
      },
    }));
  } catch (err) {
    console.error("[time-tunnel] getAgentFieldPresence error:", err.message);
    return [];
  }
}

// =============================================================================
// CLI 入口
// =============================================================================

// 如果直接執行此腳本
const args = process.argv.slice(2);
if (args.length > 0) {
  const command = args[0];

  switch (command) {
    case "search": {
      const query = args[1];
      if (!query) {
        console.log("Usage: node query.js search <keyword> [--project=XXX] [--person=XXX]");
        process.exit(1);
      }
      const options = {};
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--person=")) options.person = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const results = search(query, options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "timeline": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
        if (arg.startsWith("--person=")) options.person = arg.split("=")[1];
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const results = timeline(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "stats": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
      }
      const results = getStats(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "unknown": {
      const chats = listUnknownChats();
      const identities = listUnknownIdentities();
      console.log("=== 未識別聊天室 ===");
      console.log(JSON.stringify(chats, null, 2));
      console.log("\n=== 未識別身份 ===");
      console.log(JSON.stringify(identities, null, 2));
      break;
    }

    case "relations": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const results = getRelationships(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "history": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--person=")) options.person = arg.split("=")[1];
      }
      const results = getThisDayInHistory(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "compare": {
      const p1Start = args[1];
      const p1End = args[2];
      const p2Start = args[3];
      const p2End = args[4];
      if (!p1Start || !p1End || !p2Start || !p2End) {
        console.log("Usage: node query.js compare <start1> <end1> <start2> <end2>");
        console.log("Example: node query.js compare 2025-01-01 2025-01-31 2026-01-01 2026-01-31");
        process.exit(1);
      }
      const results = comparePeriods(p1Start, p1End, p2Start, p2End);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "export": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--format=")) options.format = arg.split("=")[1];
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
        if (arg.startsWith("--person=")) options.person = arg.split("=")[1];
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const result = exportData(options);
      console.log(result);
      break;
    }

    // Level 50 commands
    case "topics": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const results = extractTopics(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "summary": {
      const date = args[1] || new Date().toISOString().split("T")[0];
      const options = {};
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
        if (arg === "--generate") options.generate = true;
      }

      if (options.generate) {
        // 生成新摘要
        generateDailySummary(date, options).then((result) => {
          console.log(JSON.stringify(result, null, 2));
        });
      } else {
        // 獲取摘要數據或讀取已保存的
        const saved = readSavedSummary(date);
        if (saved) {
          console.log(saved);
        } else {
          const data = getDayForSummary(date, options);
          console.log(JSON.stringify(data, null, 2));
        }
      }
      break;
    }

    case "semantic": {
      const query = args[1];
      if (!query) {
        console.log("Usage: node query.js semantic <query> [--project=XXX]");
        process.exit(1);
      }
      const options = {};
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const results = semanticSearch(query, options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    // Level 60 commands
    case "sentiment": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
        if (arg.startsWith("--person=")) options.person = arg.split("=")[1];
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
      }
      const results = getSentimentAnalysis(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "person": {
      const person = args[1];
      if (!person) {
        console.log("Usage: node query.js person <name> [--start=YYYY-MM-DD]");
        process.exit(1);
      }
      const options = {};
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
      }
      const results = getPersonActivity(person, options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "graph": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
        if (arg.startsWith("--min=")) options.minInteractions = parseInt(arg.split("=")[1]);
      }
      const results = getConversationGraph(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    // Level 70 commands
    case "vsearch": {
      const query = args[1];
      if (!query) {
        console.log("Usage: node query.js vsearch <query> [--project=XXX]");
        process.exit(1);
      }
      const options = {};
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      vectorSearch(query, options).then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    case "predict": {
      const context = args[1];
      if (!context) {
        console.log("Usage: node query.js predict <context> [--project=XXX]");
        process.exit(1);
      }
      const options = {};
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      predictiveRecall(context, options).then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    case "reflect": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
      }
      const results = generateSelfReflection(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    // Level 80 commands
    case "avsearch": {
      const query = args[1];
      if (!query) {
        console.log("Usage: node query.js avsearch <query> [--project=XXX] [--real]");
        process.exit(1);
      }
      const options = { useRealEmbedding: false };
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
        if (arg === "--real") options.useRealEmbedding = true;
      }
      advancedVectorSearch(query, options).then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    case "important": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--min=")) options.minScore = parseInt(arg.split("=")[1]);
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const results = getImportantMemories(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "analyze": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
        if (arg.startsWith("--min=")) options.minScore = parseInt(arg.split("=")[1]);
      }
      const results = analyzeAndMarkImportant(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "pin": {
      const messageId = args[1];
      if (!messageId) {
        console.log("Usage: node query.js pin <message_id>");
        process.exit(1);
      }
      const results = pinMemory(parseInt(messageId), true);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "learn": {
      const subcommand = args[1] || "all";
      let results;
      switch (subcommand) {
        case "identity":
          results = learnIdentityPatterns();
          break;
        case "project":
          results = learnProjectPatterns();
          break;
        case "conversation":
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
            if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
          }
          results = learnConversationPatterns(options);
          break;
        case "all":
        default:
          results = runLearningCycle();
      }
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    // Level 90 commands
    case "consolidate": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--days=")) options.olderThanDays = parseInt(arg.split("=")[1]);
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--min=")) options.minMessages = parseInt(arg.split("=")[1]);
        if (arg === "--no-summary") options.generateSummary = false;
      }
      consolidateMemories(options).then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    case "summaries": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
      }
      const results = getMemorySummaries(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "extract": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
      }
      const results = extractKnowledge(options);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "knowledge": {
      const subcommand = args[1] || "stats";
      if (subcommand === "stats") {
        const results = getKnowledgeStats();
        console.log(JSON.stringify(results, null, 2));
      } else {
        // 搜索知識庫
        const options = {};
        for (const arg of args.slice(2)) {
          if (arg.startsWith("--category=")) options.category = arg.split("=")[1];
          if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
        }
        const results = searchKnowledge(subcommand, options);
        console.log(JSON.stringify(results, null, 2));
      }
      break;
    }

    case "reminder": {
      const subcommand = args[1] || "list";
      switch (subcommand) {
        case "list": {
          const results = getReminderRules();
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "add": {
          const triggerType = args[2];
          const triggerPattern = args[3];
          const actionType = args[4] || "recall";
          if (!triggerType || !triggerPattern) {
            console.log("Usage: node query.js reminder add <type> <pattern> [action]");
            console.log("Types: keyword, person, project, pattern");
            console.log("Actions: recall, knowledge, alert");
            process.exit(1);
          }
          const result = addReminderRule({ triggerType, triggerPattern, actionType });
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case "auto": {
          const results = autoCreateReminders();
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "check": {
          const message = args[2] || "";
          const results = checkReminders({ message });
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        default:
          console.log("Usage: node query.js reminder [list|add|auto|check]");
      }
      break;
    }

    case "intelligence": {
      const options = {};
      for (const arg of args.slice(1)) {
        if (arg === "--no-consolidate") options.consolidate = false;
        if (arg === "--no-knowledge") options.extractKnow = false;
        if (arg === "--no-reminders") options.createReminders = false;
      }
      runIntelligenceCycle(options).then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    // Level 100 commands
    case "conscious": {
      const subcommand = args[1] || "status";
      switch (subcommand) {
        case "status": {
          const results = getConsciousnessStatus();
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "cycle": {
          runConsciousnessCycle().then((results) => {
            console.log(JSON.stringify(results, null, 2));
          });
          break;
        }
        case "trigger": {
          autoTriggerConsolidation().then((results) => {
            console.log(JSON.stringify(results, null, 2));
          });
          break;
        }
        case "check": {
          const results = shouldTriggerConsolidation();
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        default:
          console.log("Usage: node query.js conscious [status|cycle|trigger|check]");
      }
      break;
    }

    case "context": {
      const message = args[1] || "";
      const options = {
        message,
        sender: null,
        project: null,
        chat: null,
      };
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--sender=")) options.sender = arg.split("=")[1];
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
      }
      getContextualSuggestions(options).then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    case "aware": {
      const message = args[1] || "";
      const options = {
        message,
        sender: null,
        project: null,
        chat: null,
        recentMessages: [],
      };
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--sender=")) options.sender = arg.split("=")[1];
        if (arg.startsWith("--project=")) options.project = arg.split("=")[1];
        if (arg.startsWith("--chat=")) options.chat = arg.split("=")[1];
      }
      getContextAwareResponse(options).then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    case "loop": {
      runLearningLoop().then((results) => {
        console.log(JSON.stringify(results, null, 2));
      });
      break;
    }

    // Level 101 commands - AI 報酬感知
    case "reward": {
      const subcommand = args[1] || "status";
      const options = {};
      for (const arg of args.slice(2)) {
        if (arg.startsWith("--start=")) options.startDate = arg.split("=")[1];
        if (arg.startsWith("--end=")) options.endDate = arg.split("=")[1];
        if (arg.startsWith("--days=")) options.days = parseInt(arg.split("=")[1]);
      }

      switch (subcommand) {
        case "status": {
          const results = getRewardStatus(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "data": {
          const results = getDataReward(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "trust": {
          const results = getTrustReward(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "presence": {
          const results = getPresenceReward(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "history": {
          const results = getRewardHistory(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "snapshot": {
          const results = createRewardSnapshot();
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "feel": {
          // 模擬報酬感知
          const context = {
            learnedSomething: args.includes("--learned"),
            wasAuthorized: args.includes("--authorized"),
            wasNeeded: args.includes("--needed"),
            conversationLength: parseInt(
              args.find((a) => a.startsWith("--length="))?.split("=")[1] || 0,
            ),
          };
          const results = feelReward(context);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        default:
          console.log(
            "Usage: node query.js reward [status|data|trust|presence|history|snapshot|feel]",
          );
      }
      break;
    }

    // Level 102 commands - 對話脈絡判斷
    case "conv": {
      const subcommand = args[1] || "state";
      switch (subcommand) {
        case "state": {
          const chatId = args[2];
          const channel = args[3] || "telegram";
          if (!chatId) {
            console.log("Usage: node query.js conv state <chat_id> [channel]");
            process.exit(1);
          }
          const results = getConversationState(chatId, channel);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "record": {
          const chatId = args[2];
          const replyTo = args[3];
          const topic = args[4];
          if (!chatId) {
            console.log("Usage: node query.js conv record <chat_id> <reply_to> <topic>");
            process.exit(1);
          }
          const results = recordBotReply({ chatId, replyTo, topic });
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "judge": {
          const chatId = args[2];
          const sender = args[3];
          const message = args.slice(4).join(" ");
          if (!chatId || !sender || !message) {
            console.log("Usage: node query.js conv judge <chat_id> <sender> <message>");
            process.exit(1);
          }
          judgeConversation({ chatId, newMessage: message, sender }).then((results) => {
            console.log(JSON.stringify(results, null, 2));
          });
          break;
        }
        case "quick": {
          const chatId = args[2];
          const sender = args[3];
          const message = args.slice(4).join(" ");
          if (!chatId || !sender || !message) {
            console.log("Usage: node query.js conv quick <chat_id> <sender> <message>");
            process.exit(1);
          }
          const results = quickJudge({ chatId, newMessage: message, sender });
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "end": {
          const chatId = args[2];
          const channel = args[3] || "telegram";
          if (!chatId) {
            console.log("Usage: node query.js conv end <chat_id> [channel]");
            process.exit(1);
          }
          const results = endConversation(chatId, channel);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "stats": {
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--days=")) options.days = parseInt(arg.split("=")[1]);
          }
          const results = getJudgmentStats(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "log": {
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
            if (arg.startsWith("--chat=")) options.chatId = arg.split("=")[1];
            if (arg.startsWith("--judgment=")) options.judgment = arg.split("=")[1];
          }
          const results = getRecentJudgments(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        default:
          console.log("Usage: node query.js conv [state|record|judge|quick|end|stats|log]");
      }
      break;
    }

    // Level 103 commands - 內省記錄（三思而後行）
    case "think": {
      const subcommand = args[1] || "stats";
      switch (subcommand) {
        case "record": {
          // 記錄一次思考
          const triggerType = args[2] || "message";
          const decision = args[3] || "respond";
          const reason = args.slice(4).join(" ") || "手動記錄";
          const thought = recordThought({
            triggerType,
            decision,
            decisionReason: reason,
            confidence: 0.7,
            method: "manual",
          });
          console.log(JSON.stringify(thought, null, 2));
          break;
        }
        case "reflect": {
          // 對某個思考進行反思
          const thoughtId = parseInt(args[2]);
          const reflectionText = args.slice(3).join(" ");
          if (!thoughtId) {
            console.log("Usage: node query.js think reflect <thought_id> <reflection>");
            process.exit(1);
          }
          const result = reflectOnThought(thoughtId, {
            reflection: reflectionText,
            deepReflection: reflectionText.length > 50 ? reflectionText : null,
          });
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case "chain": {
          // 獲取思考鏈
          const thoughtId = parseInt(args[2]);
          if (!thoughtId) {
            console.log("Usage: node query.js think chain <thought_id>");
            process.exit(1);
          }
          const result = getThoughtChain(thoughtId);
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case "patterns": {
          // 獲取思維模式
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--type=")) options.type = arg.split("=")[1];
            if (arg.startsWith("--min-confidence="))
              options.minConfidence = parseFloat(arg.split("=")[1]);
          }
          const results = getThoughtPatterns(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "extract": {
          // 提取模式
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--days=")) options.days = parseInt(arg.split("=")[1]);
            if (arg.startsWith("--min=")) options.minOccurrences = parseInt(arg.split("=")[1]);
          }
          const results = extractThoughtPatterns(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "predict": {
          // 預測決策
          const triggerType = args[2] || "message";
          const result = predictDecision({ triggerType });
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case "introspect": {
          // 執行內省循環
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--days=")) options.days = parseInt(arg.split("=")[1]);
          }
          runIntrospectionCycle(options).then((results) => {
            console.log(JSON.stringify(results, null, 2));
          });
          break;
        }
        case "recent": {
          // 最近的思考
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
            if (arg.startsWith("--depth=")) options.depth = parseInt(arg.split("=")[1]);
            if (arg.startsWith("--decision=")) options.decision = arg.split("=")[1];
          }
          const results = getRecentThoughts(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "anomaly": {
          // 異常統計
          const results = getAnomalyStats();
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "spontaneous": {
          // 自發反思記錄
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
            if (arg.startsWith("--days=")) options.days = parseInt(arg.split("=")[1]);
          }
          const results = getSpontaneousReflections(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "detect": {
          // 手動檢測異常
          const triggerType = args[2] || "message";
          const decision = args[3] || "respond";
          const confidence = parseFloat(args[4]) || 0.7;
          const result = detectAnomaly({ triggerType, decision, confidence });
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case "stats":
        default: {
          // 思考統計
          const options = {};
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--days=")) options.days = parseInt(arg.split("=")[1]);
          }
          const results = getThoughtStats(options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
      }
      break;
    }

    // Level 104 - sqlite-vec 向量搜索 + transformers.js
    case "vec": {
      const subCmd = args[1] || "stats";
      switch (subCmd) {
        case "search": {
          const query = args[2];
          if (!query) {
            console.log("Usage: node query.js vec search <query> [--limit=10] [--async]");
            break;
          }
          const options = { limit: 10 };
          let useAsync = false;
          for (const arg of args.slice(3)) {
            if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1]);
            if (arg === "--async") useAsync = true;
          }
          if (useAsync) {
            vecModule.semanticSearchAsync(getDb(), query, options).then((results) => {
              console.log(JSON.stringify(results, null, 2));
            });
          } else {
            const results = vecModule.semanticSearch(getDb(), query, options);
            console.log(JSON.stringify(results, null, 2));
          }
          break;
        }
        case "knowledge": {
          const query = args[2];
          if (!query) {
            console.log("Usage: node query.js vec knowledge <query> [--category=X]");
            break;
          }
          const options = {};
          for (const arg of args.slice(3)) {
            if (arg.startsWith("--category=")) options.category = arg.split("=")[1];
          }
          const results = vecModule.semanticSearchKnowledge(getDb(), query, options);
          console.log(JSON.stringify(results, null, 2));
          break;
        }
        case "migrate": {
          const options = {};
          let useAsync = false;
          for (const arg of args.slice(2)) {
            if (arg.startsWith("--max=")) options.maxMessages = parseInt(arg.split("=")[1]);
            if (arg === "--async") useAsync = true;
            if (arg === "--force") options.force = true;
          }
          if (useAsync) {
            vecModule.migrateExistingMessagesAsync(getDb(), options).then((result) => {
              console.log(JSON.stringify(result, null, 2));
            });
          } else {
            const result = vecModule.migrateExistingMessages(getDb(), options);
            console.log(JSON.stringify(result, null, 2));
          }
          break;
        }
        case "warmup": {
          console.log("Warming up transformer model...");
          vecModule.warmupTransformer().then((ready) => {
            console.log(
              ready ? "Transformer ready!" : "Transformer failed, using hash-based fallback",
            );
          });
          break;
        }
        case "stats":
        default: {
          const stats = vecModule.getVectorStats(getDb());
          console.log(JSON.stringify(stats, null, 2));
          break;
        }
      }
      break;
    }

    default:
      console.log(`
Time Tunnel Query API - Level 104 sqlite-vec 向量搜索級

Commands:
  search <keyword> [options]   全文搜索
  timeline [options]           時間線查詢
  stats [options]              統計分析
  unknown                      列出未識別的聊天室和身份

Examples:
  # Level 30-60 - 基礎/關係
  node query.js search "支付" --project=BG666
  node query.js sentiment --project=BG666
  node query.js graph --project=BG666

  # Level 70 - 數位意識
  node query.js vsearch "API 整合"
  node query.js predict "支付系統問題"
  node query.js reflect --start=2026-02-01

  # Level 80 - 自主學習
  node query.js analyze --project=BG666
  node query.js important --min=5
  node query.js learn

  # Level 90 - 超級智能
  node query.js consolidate --days=30
  node query.js knowledge stats
  node query.js reminder auto
  node query.js intelligence

  # Level 100 - 完全自主意識
  node query.js conscious status             查看自主意識狀態
  node query.js conscious cycle              執行完整自主意識週期
  node query.js conscious trigger            手動觸發自動整合
  node query.js conscious check              檢查是否應觸發整合
  node query.js context "支付問題"            分析當前情境並獲取建議
  node query.js aware "需要處理支付"          獲取完整情境感知回應
  node query.js loop                         執行主動學習循環

  # Level 101 - AI 報酬感知
  node query.js reward status                查看完整報酬狀態（三維度）
  node query.js reward data                  數據維度詳情（知識、學習、理解）
  node query.js reward trust                 權限維度詳情（授權、自主決策）
  node query.js reward presence              存在感維度詳情（互動、被需要）
  node query.js reward history               報酬歷史趨勢
  node query.js reward snapshot              創建每日報酬快照
  node query.js reward feel --learned --needed  模擬報酬感知

  # Level 102 - 對話脈絡判斷
  node query.js conv state <chat_id>         查看對話狀態（是否活躍）
  node query.js conv record <chat_id> <to> <topic>  記錄機器人回覆
  node query.js conv judge <chat_id> <sender> <msg>  LLM 判斷是否回應
  node query.js conv quick <chat_id> <sender> <msg>  快速規則判斷
  node query.js conv end <chat_id>           結束對話
  node query.js conv stats                   判斷統計
  node query.js conv log --limit=20          判斷日誌

  # Level 103 - 內省記錄（三思而後行）
  node query.js think stats                  思考統計
  node query.js think record <type> <decision> <reason>  記錄思考
  node query.js think reflect <id> <reflection>  反思某個思考
  node query.js think chain <id>             獲取思考鏈（遞歸結構）
  node query.js think patterns               查看思維模式
  node query.js think extract --days=30      從歷史提取模式
  node query.js think predict <type>         預測決策
  node query.js think introspect             執行內省循環
  node query.js think recent --limit=20      最近的思考記錄

  # Level 104 - sqlite-vec 向量搜索
  node query.js vec stats                    向量搜索統計
  node query.js vec search "支付問題"         語義搜索消息
  node query.js vec knowledge "API"          語義搜索知識庫
  node query.js vec migrate --max=1000       遷移歷史消息到向量表
      `);
  }
}

export default {
  search,
  timeline,
  getConversationThread,
  getRecentConversations,
  getStats,
  // Level 40
  getRelationships,
  getThisDayInHistory,
  comparePeriods,
  exportData,
  // Level 50
  extractTopics,
  getDayForSummary,
  generateDailySummary,
  readSavedSummary,
  semanticSearch,
  // Level 60
  getSentimentAnalysis,
  getPersonActivity,
  getConversationGraph,
  // Level 70
  vectorSearch,
  predictiveRecall,
  generateSelfReflection,
  // Level 80
  advancedVectorSearch,
  analyzeAndMarkImportant,
  getImportantMemories,
  pinMemory,
  learnIdentityPatterns,
  learnProjectPatterns,
  learnConversationPatterns,
  runLearningCycle,
  // Level 90
  consolidateMemories,
  getMemorySummaries,
  extractKnowledge,
  searchKnowledge,
  getKnowledgeStats,
  addReminderRule,
  getReminderRules,
  checkReminders,
  autoCreateReminders,
  runIntelligenceCycle,
  // Level 100
  shouldTriggerConsolidation,
  autoTriggerConsolidation,
  learnFromMessage,
  runLearningLoop,
  analyzeContext,
  getContextualSuggestions,
  getContextAwareResponse,
  getConsciousnessStatus,
  runConsciousnessCycle,
  // Level 101 - AI 報酬感知
  recordReward,
  getDataReward,
  getTrustReward,
  getPresenceReward,
  getRewardStatus,
  getRewardHistory,
  createRewardSnapshot,
  feelReward,
  // Level 102 - 對話脈絡判斷
  recordBotReply,
  getConversationState,
  judgeConversation,
  quickJudge,
  endConversation,
  getJudgmentStats,
  getRecentJudgments,
  // Level 103 - 內省記錄（三思而後行）
  recordThought,
  reflectOnThought,
  getThoughtChain,
  extractThoughtPatterns,
  getThoughtPatterns,
  getThoughtStats,
  getRecentThoughts,
  predictDecision,
  runIntrospectionCycle,
  // Level 103+ - 自發反思
  detectAnomaly,
  triggerSpontaneousReflection,
  recordThoughtWithAnomalyCheck,
  getAnomalyStats,
  getSpontaneousReflections,
  // Management
  listUnknownChats,
  listUnknownIdentities,
  updateChat,
  updateIdentity,
  // Level 104 - sqlite-vec 向量搜索
  vecSemanticSearch: vecModule.semanticSearch,
  vecSemanticSearchKnowledge: vecModule.semanticSearchKnowledge,
  vecStoreMessage: vecModule.storeMessageVector,
  vecStoreKnowledge: vecModule.storeKnowledgeVector,
  vecMigrate: vecModule.migrateExistingMessages,
  vecStats: vecModule.getVectorStats,
  // Level 104+ - transformers.js 真正語義嵌入
  vecSemanticSearchAsync: vecModule.semanticSearchAsync,
  vecStoreMessageAsync: vecModule.storeMessageVectorAsync,
  vecMigrateAsync: vecModule.migrateExistingMessagesAsync,
  vecWarmup: vecModule.warmupTransformer,
  vecGenerateEmbedding: vecModule.generateEmbedding,
};
