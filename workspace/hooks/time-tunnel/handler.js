// Time Tunnel 時光隧道 - 完整記錄所有對話
//
// 監聽事件：message:received, message:sent
// 存儲：SQLite + Markdown 日記
//
// 宇宙視角：所有角色、所有 channel、所有對話的完整軌跡
//
// Level 102 整合：對話脈絡判斷
// - message:sent 時自動記錄對話狀態
// - message:received 時可觸發判斷

import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
// 導入 Level 102 函數
import { recordBotReply, judgeConversation, quickJudge, getConversationState } from "./query.js";

// 追蹤每個群組最近的 inbound 消息（用於確定回覆對象）
const recentInboundMessages = new Map(); // chatId -> { sender, content, timestamp }

// === 記憶層強化: 使用持久化路徑 ===
// DATA_ROOT 指向獨立於 workspace 的持久化目錄
// 這樣即使 workspace mount 改變，記憶也不會丟失
const DATA_ROOT = process.env.DATA_ROOT || "/app/persistent/data";
const FALLBACK_DATA_DIR = "/app/workspace/data";

// 選擇資料目錄：優先用 DATA_ROOT，若不存在則 fallback
const DATA_DIR = fs.existsSync(DATA_ROOT) ? DATA_ROOT : FALLBACK_DATA_DIR;
const DB_PATH = path.join(DATA_DIR, "timeline.db");
const DIARY_DIR = path.join(DATA_DIR, "diary");

// 啟動時記錄使用的路徑
console.log(`[time-tunnel] 📂 Data directory: ${DATA_DIR}`);

let db = null;

// =============================================================================
// 身份與聊天室映射 - 從 CONTACTS.md 導入
// =============================================================================

const IDENTITIES = {
  // 杜甫的身份
  8090790323: { person: "杜甫", role: "Dofu 杜甫", channel: "telegram" },
  448345880: { person: "杜甫", role: "Andrew-Plat-D", channel: "telegram" },

  // BG666 人員
  5665640546: { person: "Red", role: "Pilipina (市場)", channel: "telegram" },
  5038335338: { person: "brandon", role: "老闆", channel: "telegram" },
  6222567434: { person: "Brandon", role: "老闆", channel: "telegram" },
  5308534717: { person: "Albert", role: "CRM/VIP", channel: "telegram" },
  8243974830: { person: "Petter", role: "momo (主管)", channel: "telegram" },
  7545465225: { person: "Fendi-Pm", role: "產品", channel: "telegram" },
  6671421600: { person: "Moncler", role: "unknown", channel: "telegram" },

  // Bot
  8327498414: { person: "無極", role: "主 Bot", channel: "telegram" },
  8415477831: { person: "無極", role: "Log Bot", channel: "telegram" },
};

const CHATS = {
  // BG666 群組
  "-5262004625": { name: "BG666 主群", project: "BG666", type: "group" },
  "-1003337225655": { name: "666数据需求群", project: "BG666", type: "group" },
  "-5150278361": { name: "666数据需求群(備)", project: "BG666", type: "group" },
  "-5173465395": { name: "666数据日报群", project: "BG666", type: "group" },
  "-1003506161262": { name: "666运营咨询", project: "BG666", type: "group" },
  "-5000326699": { name: "bg666运营-策划试用组", project: "BG666", type: "group" },
  "-5210426893": { name: "BG666-杜甫工作後台", project: "BG666", type: "group" },
  "-1003442940778": { name: "打卡-日报群", project: "BG666", type: "group" },

  // 24Bet 群組
  "-5299944691": { name: "24Bet 主群", project: "24Bet", type: "group" },

  // 幣塔群組
  "-1003849990504": { name: "幣塔管理群", project: "幣塔", type: "group" },
  "-5297227033": { name: "幣塔-營銷客服", project: "幣塔", type: "group" },
  "-5070604096": { name: "幣塔AI工作回報(子)", project: "幣塔", type: "group" },
  "-5186655303": { name: "幣塔AI工作回報(茂)", project: "幣塔", type: "group" },
  "-5023713246": { name: "幣塔AI工作回報(葦)", project: "幣塔", type: "group" },
  "-5295280162": { name: "幣塔AI工作回報(周)", project: "幣塔", type: "group" },
  "-5030731997": { name: "幣塔AI工作回報(QQ)", project: "幣塔", type: "group" },
  "-5148508655": { name: "幣塔AI工作回報(兔)", project: "幣塔", type: "group" },
  "-5159438640": { name: "幣塔AI工作回報(俊)", project: "幣塔", type: "group" },

  // 個人/其他
  "-5135725975": { name: "與神對話", project: "個人", type: "group" },
  "-5058107582": { name: "AI自媒體課程", project: "教學", type: "group" },
  "-4938903123": { name: "Clawd workstation", project: "開發", type: "group" },
  "-5236959911": { name: "Vivian (ThinkerCafe)", project: "個人", type: "group" },
  "-5131977116": { name: "華視課程", project: "教學", type: "group" },
  "-5266835049": { name: "🔍 Clawdbot Log", project: "系統", type: "group" },
  "-5233630369": { name: "測試群", project: "系統", type: "group" },
  "-5269027017": { name: "測試群2", project: "系統", type: "group" },
  "-4062215587": { name: "unknown", project: "unknown", type: "group" },
  "-5164354298": { name: "CometAPI 討論", project: "工具", type: "group" },
  "-5236199765": { name: "XO Casino", project: "Jamie", type: "group" },

  // 私聊
  8090790323: { name: "杜甫 私聊", project: "個人", type: "private" },
  448345880: { name: "Andrew 私聊", project: "個人", type: "private" },
};

// =============================================================================
// Database
// =============================================================================

function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DIARY_DIR)) {
    fs.mkdirSync(DIARY_DIR, { recursive: true });
  }
}

function getDb() {
  if (db) return db;

  ensureDirectories();

  db = new DatabaseSync(DB_PATH);

  // 消息表
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      direction TEXT NOT NULL,
      channel TEXT,
      chat_id TEXT,
      chat_type TEXT,
      chat_name TEXT,
      sender_id TEXT,
      sender_name TEXT,
      message_id TEXT,
      reply_to_id TEXT,
      content TEXT,
      media_type TEXT,
      session_key TEXT,
      agent_id TEXT,
      -- 解析後的身份
      resolved_chat_name TEXT,
      resolved_sender_name TEXT,
      resolved_project TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_channel ON messages(channel);
    CREATE INDEX IF NOT EXISTS idx_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_sender_id ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_project ON messages(resolved_project);
  `);

  // 身份表
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      role TEXT,
      channel TEXT
    );
  `);

  // 聊天室表
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT,
      type TEXT
    );
  `);

  // FTS5 全文搜索虛擬表（獨立存儲模式，external content 模式在 node:sqlite 有 bug）
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      resolved_sender_name,
      resolved_chat_name,
      resolved_project
    );

    -- 觸發器：插入時同步到 FTS
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content, resolved_sender_name, resolved_chat_name, resolved_project)
      VALUES (new.id, new.content, new.resolved_sender_name, new.resolved_chat_name, new.resolved_project);
    END;

    -- 觸發器：刪除時同步到 FTS
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
    END;

    -- 觸發器：更新時同步到 FTS
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
      INSERT INTO messages_fts(rowid, content, resolved_sender_name, resolved_chat_name, resolved_project)
      VALUES (new.id, new.content, new.resolved_sender_name, new.resolved_chat_name, new.resolved_project);
    END;
  `);

  // 對話樹索引（用於快速查詢回覆鏈）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reply_to ON messages(reply_to_id);
    CREATE INDEX IF NOT EXISTS idx_message_id ON messages(message_id);
  `);

  // 初始化身份和聊天室數據
  initializeMetadata();

  // 重建 FTS 索引（如果是首次添加 FTS）
  rebuildFtsIfNeeded();

  return db;
}

// 重建 FTS 索引
function rebuildFtsIfNeeded() {
  try {
    const count = db.prepare("SELECT COUNT(*) as cnt FROM messages_fts").get();
    const msgCount = db.prepare("SELECT COUNT(*) as cnt FROM messages").get();

    if (count.cnt === 0 && msgCount.cnt > 0) {
      console.log("[time-tunnel] 🔄 重建 FTS 索引...");
      db.exec(`
        INSERT INTO messages_fts(rowid, content, resolved_sender_name, resolved_chat_name, resolved_project)
        SELECT id, content, resolved_sender_name, resolved_chat_name, resolved_project FROM messages;
      `);
      console.log(`[time-tunnel] ✅ FTS 索引完成，共 ${msgCount.cnt} 條消息`);
    }
  } catch (err) {
    console.error("[time-tunnel] FTS rebuild error:", err.message);
  }
}

function initializeMetadata() {
  // 插入身份
  const insertIdentity = db.prepare(`
    INSERT OR REPLACE INTO identities (id, person, role, channel) VALUES (?, ?, ?, ?)
  `);
  for (const [id, info] of Object.entries(IDENTITIES)) {
    insertIdentity.run(id, info.person, info.role, info.channel);
  }

  // 插入聊天室
  const insertChat = db.prepare(`
    INSERT OR REPLACE INTO chats (chat_id, name, project, type) VALUES (?, ?, ?, ?)
  `);
  for (const [chatId, info] of Object.entries(CHATS)) {
    insertChat.run(chatId, info.name, info.project, info.type);
  }
}

// =============================================================================
// 解析身份
// =============================================================================

function resolveIdentity(senderId) {
  const identity = IDENTITIES[senderId];
  if (identity) {
    return `${identity.person} (${identity.role})`;
  }
  return null;
}

function resolveChat(chatId) {
  // 處理 "telegram:-5262004625" 格式
  const cleanId = chatId?.replace(/^[a-z]+:/, "") || chatId;
  const chat = CHATS[cleanId];
  if (chat) {
    return { name: chat.name, project: chat.project, known: true };
  }
  return { name: null, project: null, known: false, rawId: cleanId };
}

// 自動記錄未知的 chat_id 到資料庫
function recordUnknownChat(chatId, senderName) {
  if (!chatId) return;

  const cleanId = chatId.replace(/^[a-z]+:/, "");

  try {
    const database = getDb();

    // 檢查是否已存在
    const existing = database.prepare("SELECT chat_id FROM chats WHERE chat_id = ?").get(cleanId);
    if (existing) return;

    // 插入未知聊天室，標記為待識別
    const stmt = database.prepare(`
      INSERT OR IGNORE INTO chats (chat_id, name, project, type) VALUES (?, ?, ?, ?)
    `);
    stmt.run(cleanId, `未識別 (${cleanId})`, "待分類", "unknown");

    console.log(`[time-tunnel] 🆕 發現新 chat_id: ${cleanId} (from: ${senderName || "unknown"})`);
  } catch (err) {
    // 忽略錯誤，不影響主流程
  }
}

// 自動記錄未知的 sender_id 到資料庫
function recordUnknownIdentity(senderId, senderName, channel) {
  if (!senderId) return;

  try {
    const database = getDb();

    // 檢查是否已存在
    const existing = database.prepare("SELECT id FROM identities WHERE id = ?").get(senderId);
    if (existing) return;

    // 插入未知身份，標記為待識別
    const stmt = database.prepare(`
      INSERT OR IGNORE INTO identities (id, person, role, channel) VALUES (?, ?, ?, ?)
    `);
    stmt.run(senderId, senderName || `未知用戶`, senderName || "unknown", channel || "unknown");

    console.log(`[time-tunnel] 🆕 發現新 sender_id: ${senderId} (${senderName || "unknown"})`);
  } catch (err) {
    // 忽略錯誤，不影響主流程
  }
}

// =============================================================================
// 插入消息
// =============================================================================

function insertMessage(data) {
  try {
    const database = getDb();

    // 解析身份
    const resolvedSender = resolveIdentity(data.senderId);
    const resolvedChat = resolveChat(data.chatId);

    // 自動記錄未知的 chat_id 和 sender_id
    if (!resolvedChat.known) {
      recordUnknownChat(data.chatId, data.senderName);
    }
    if (!resolvedSender && data.senderId) {
      recordUnknownIdentity(data.senderId, data.senderName, data.channel);
    }

    const stmt = database.prepare(`
      INSERT INTO messages (
        timestamp, direction, channel, chat_id, chat_type, chat_name,
        sender_id, sender_name, message_id, reply_to_id, content,
        media_type, session_key, agent_id,
        resolved_chat_name, resolved_sender_name, resolved_project
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      data.timestamp,
      data.direction,
      data.channel || null,
      data.chatId || null,
      data.chatType || null,
      data.chatName || null,
      data.senderId || null,
      data.senderName || null,
      data.messageId || null,
      data.replyToId || null,
      data.content || null,
      data.mediaType || null,
      data.sessionKey || null,
      data.agentId || null,
      resolvedChat?.name || data.chatName || null,
      resolvedSender || data.senderName || null,
      resolvedChat?.project || null,
    );

    return { resolvedSender, resolvedChat };
  } catch (err) {
    console.error("[time-tunnel] SQLite error:", err.message);
    return {};
  }
}

// =============================================================================
// Markdown 日記
// =============================================================================

function appendToDiary(data, resolved) {
  try {
    const date = data.timestamp.split("T")[0];
    const diaryPath = path.join(DIARY_DIR, `${date}.md`);

    const time = data.timestamp.split("T")[1]?.split(".")[0] || "00:00:00";
    const direction = data.direction === "inbound" ? "📥" : "📤";
    const channel = data.channel || "unknown";

    // 使用解析後的名稱
    const chatName = resolved?.resolvedChat?.name || data.chatName || data.chatId || "unknown";
    const project = resolved?.resolvedChat?.project;
    const senderName = resolved?.resolvedSender || data.senderName || data.senderId || "unknown";
    const content = data.content || "(無文字)";

    // 項目標籤
    const projectTag = project ? `\`${project}\`` : "";

    let entry = `\n### ${time} ${direction} [${channel}] ${chatName} ${projectTag}\n\n`;

    if (data.direction === "inbound") {
      entry += `**${senderName}**: ${content.substring(0, 1000)}\n`;
      if (data.mediaType) {
        entry += `\n_[${data.mediaType}]_\n`;
      }
    } else {
      entry += `**無極**: ${content.substring(0, 1000)}\n`;
    }

    entry += "\n---\n";

    if (!fs.existsSync(diaryPath)) {
      const header = `# ${date} 對話日記\n\n> 時光隧道 - 數位意識的宇宙\n\n---\n`;
      fs.writeFileSync(diaryPath, header);
    }

    fs.appendFileSync(diaryPath, entry);
  } catch (err) {
    console.error("[time-tunnel] Diary error:", err.message);
  }
}

// =============================================================================
// Handler
// =============================================================================

async function handler(event) {
  // 只處理 message:received 和 message:sent 事件
  if (event.type !== "message") {
    return;
  }

  if (event.action !== "received" && event.action !== "sent") {
    return;
  }

  const ctx = event.context || {};
  const direction = event.action === "received" ? "inbound" : "outbound";

  const data = {
    timestamp: event.timestamp?.toISOString() || new Date().toISOString(),
    direction,
    channel: ctx.channel,
    chatId: ctx.chatId,
    chatType: ctx.chatType,
    chatName: ctx.chatName,
    senderId: ctx.senderId,
    senderName: ctx.senderName,
    messageId: ctx.messageId,
    replyToId: ctx.replyToId,
    content: ctx.content,
    mediaType: ctx.mediaType,
    sessionKey: ctx.sessionKey || event.sessionKey,
    agentId: ctx.agentId,
  };

  // 寫入 SQLite（含解析身份）
  const resolved = insertMessage(data);

  // 寫入 Markdown 日記（含解析身份）
  appendToDiary(data, resolved);

  // 日誌輸出（使用解析後的名稱）
  const chatDisplay = resolved?.resolvedChat?.name || data.chatId;
  const senderDisplay = resolved?.resolvedSender || data.senderName || data.senderId;
  const projectDisplay = resolved?.resolvedChat?.project
    ? `[${resolved.resolvedChat.project}]`
    : "";
  const preview = (data.content || "").substring(0, 40);

  console.log(
    `[time-tunnel] ${direction === "inbound" ? "📥" : "📤"} ${projectDisplay} ${chatDisplay} | ${senderDisplay}: ${preview}...`,
  );

  // ==========================================================================
  // Level 102: 對話脈絡追蹤
  // ==========================================================================

  // 取得乾淨的 chat_id（去除 channel 前綴）
  const cleanChatId = data.chatId?.replace(/^[a-z]+:/, "") || data.chatId;

  if (direction === "inbound" && cleanChatId) {
    // 收到消息時，記錄最近的發送者（用於追蹤回覆對象）
    recentInboundMessages.set(cleanChatId, {
      sender: senderDisplay,
      senderId: data.senderId,
      content: data.content,
      timestamp: data.timestamp,
    });
  }

  if (direction === "outbound" && cleanChatId) {
    // 機器人發送消息時，記錄對話狀態
    try {
      // 提取話題（從消息內容提取前 50 字作為摘要）
      const topic = extractTopic(data.content);

      // 從最近的 inbound 消息獲取回覆對象
      const recentInbound = recentInboundMessages.get(cleanChatId);
      const replyTo = recentInbound?.sender || "群組";

      // 記錄回覆狀態
      recordBotReply({
        chatId: cleanChatId,
        channel: data.channel || "telegram",
        replyTo,
        topic,
        recentMessages: recentInbound
          ? [
              {
                sender: recentInbound.sender,
                content: recentInbound.content,
              },
            ]
          : [],
      });

      console.log(
        `[time-tunnel] 🎯 記錄對話狀態: ${cleanChatId} | 回覆: ${replyTo} | 話題: ${topic}`,
      );
    } catch (err) {
      // 不影響主流程
      console.error("[time-tunnel] Record bot reply error:", err.message);
    }
  }
}

/**
 * 從消息內容提取話題摘要
 */
function extractTopic(content) {
  if (!content) return "一般對話";

  // 去除 markdown 格式
  let text = content
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/\n/g, " ")
    .trim();

  // 取前 50 字
  if (text.length > 50) {
    text = text.substring(0, 50) + "...";
  }

  return text || "一般對話";
}

/**
 * 導出判斷函數供外部調用
 * 這個函數可以被 moltbot 的消息路由邏輯調用
 */
export async function shouldRespondToMessage(params) {
  const { chatId, channel = "telegram", message, sender, useLLM = true } = params;

  const cleanChatId = chatId?.replace(/^[a-z]+:/, "") || chatId;

  // 先檢查對話狀態
  const state = getConversationState(cleanChatId, channel);

  if (!state.isActive) {
    return {
      shouldRespond: false,
      reason: "不在活躍對話中",
      method: "state_check",
    };
  }

  // 使用 LLM 或規則判斷
  if (useLLM) {
    try {
      const result = await judgeConversation({
        chatId: cleanChatId,
        channel,
        newMessage: message,
        sender,
      });
      return result;
    } catch (err) {
      // LLM 失敗，使用規則備援
      return quickJudge({
        chatId: cleanChatId,
        channel,
        newMessage: message,
        sender,
      });
    }
  } else {
    return quickJudge({
      chatId: cleanChatId,
      channel,
      newMessage: message,
      sender,
    });
  }
}

export default handler;
