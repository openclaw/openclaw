/**
 * LINE 雙軌回覆系統
 *
 * 事件：message:received (LINE 消息)
 * 功能：
 * 1. 檢查彈夾，發送待發的深度回覆
 * 2. 記錄消息，供深度思考使用
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_PATH = "/app/workspace/data/timeline.db";
const CONFIG_PATH = "/app/workspace/hooks/config.json";

// 初始化彈夾表
function initMagazineTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_magazine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      priority INTEGER DEFAULT 0,
      fired INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_magazine_pending
    ON line_magazine(user_id, chat_id, fired) WHERE fired = 0;
  `);
}

// 獲取待發送的彈夾內容
function getMagazineContents(db, userId, chatId, limit = 4) {
  const stmt = db.prepare(`
    SELECT id, content FROM line_magazine
    WHERE user_id = ? AND chat_id = ? AND fired = 0
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `);
  return stmt.all(userId, chatId, limit);
}

// 標記彈夾已發送
function markMagazineFired(db, ids) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE line_magazine SET fired = 1 WHERE id IN (${placeholders})`).run(...ids);
}

// 存入新彈夾
function storeMagazine(db, userId, chatId, content, context = null, priority = 0) {
  db.prepare(`
    INSERT INTO line_magazine (user_id, chat_id, content, context, priority)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, chatId, content, context, priority);
}

// 主處理函數
export default async function handler(event) {
  // 只處理 LINE 消息
  if (event.type !== "message" || event.action !== "received") return;
  const ctx = event.context || {};
  if (ctx.channel !== "line") return;

  const db = new DatabaseSync(DB_PATH);

  try {
    initMagazineTable(db);

    const userId = ctx.senderId || "unknown";
    const chatId = ctx.chatId || "unknown";

    // 獲取待發送的彈夾
    const magazines = getMagazineContents(db, userId, chatId);

    if (magazines.length > 0) {
      console.log(`[line-dual-track] Found ${magazines.length} magazine items for ${userId}`);

      // 標記為已處理（實際發送由 agent 處理）
      const ids = magazines.map((m) => m.id);

      // 將彈夾內容注入到 event context，讓 agent 可以取用
      ctx._magazineContents = magazines.map((m) => m.content);
      ctx._magazineIds = ids;

      console.log(`[line-dual-track] Magazine contents attached to event`);
    }

    // 記錄這次消息，供之後的深度思考參考
    console.log(
      `[line-dual-track] LINE message from ${userId}: ${(ctx.content || "").substring(0, 50)}...`,
    );
  } catch (err) {
    console.error("[line-dual-track] Error:", err.message);
  } finally {
    db.close();
  }
}

// 供外部調用的 API
export function addToMagazine(userId, chatId, content, context = null) {
  const db = new DatabaseSync(DB_PATH);
  try {
    initMagazineTable(db);
    storeMagazine(db, userId, chatId, content, context);
    console.log(`[line-dual-track] 📥 Added to magazine for ${userId}`);
  } finally {
    db.close();
  }
}

export function getMagazineStats() {
  const db = new DatabaseSync(DB_PATH);
  try {
    initMagazineTable(db);
    const pending = db.prepare("SELECT COUNT(*) as count FROM line_magazine WHERE fired = 0").get();
    const total = db.prepare("SELECT COUNT(*) as count FROM line_magazine").get();
    return {
      pending: pending.count,
      total: total.count,
    };
  } finally {
    db.close();
  }
}
