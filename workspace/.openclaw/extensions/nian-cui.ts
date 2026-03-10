/**
 * 念·萃 (Niàn Cuì) — Memory Extraction Plugin
 *
 * Hooks into agent_end to extract key facts from conversations
 * and persist them to each agent's memory/episodes.md file.
 *
 * Part of the 無極 memory system (念).
 * M1 milestone: agents gain autonomous memory.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { DatabaseSync } from "node:sqlite";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const EXTRACTION_PROMPT = `You are a memory extraction system for a customer service agent. Given a conversation between a customer and an AI agent, extract key facts worth remembering for future interactions.

Rules:
- Extract 3-7 facts maximum
- MUST record: completed transactions (amounts, methods), customer preferences, abnormal events, handoff reasons, complaints
- MAY skip: routine FAQ answers, simple greetings, small talk
- Each fact should be one concise sentence
- Note when images were sent (e.g. transfer screenshots) — they often indicate payment proof
- Use the same language as the conversation (usually Chinese)
- If the conversation is too short or trivial, return NONE

Output format (one fact per line):
- fact 1
- fact 2
- ...

Or just: NONE`;

// --- Shadow DB connection (lazy, read-only for context) ---

let shadowDb: DatabaseSync | null = null;

function getShadowDb(): DatabaseSync | null {
  if (shadowDb) return shadowDb;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync("/data/line-shadow.db")) return null;
    shadowDb = new DatabaseSync("/data/line-shadow.db");
    shadowDb.exec("PRAGMA journal_mode=WAL");
    return shadowDb;
  } catch {
    return null;
  }
}

function saveOutboundMessages(
  userId: string,
  messages: Array<{ role: string; text: string }>,
): void {
  const db = getShadowDb();
  if (!db) return;

  try {
    const stmt = db.prepare(`
      INSERT INTO messages (timestamp, user_id, source_type, message_type, text, message_id, reply_token, raw_event, direction, media_path)
      VALUES (?, ?, 'bot', 'text', ?, NULL, NULL, '{}', 'outbound', NULL)
    `);
    const now = new Date().toISOString();
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.text) continue;
      stmt.run(now, userId, msg.text.slice(0, 10000));
    }
  } catch (err) {
    console.error(`[念·萃] outbound save error: ${err}`);
  }
}

interface DbRow {
  direction: string;
  text: string | null;
  message_type: string;
  timestamp: string;
}

function getRecentHistory(userId: string, limit = 20): string {
  const db = getShadowDb();
  if (!db) return "";

  try {
    const rows = db
      .prepare(`
      SELECT direction, text, message_type, timestamp
      FROM messages WHERE user_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `)
      .all(userId, limit) as DbRow[];

    if (rows.length === 0) return "";

    // Reverse to chronological order
    rows.reverse();
    const lines = rows.map((r) => {
      const dir = r.direction === "outbound" ? "outbound" : "inbound";
      if (r.message_type === "image") return `[${dir}] <圖片>`;
      if (r.message_type === "video") return `[${dir}] <影片>`;
      if (r.message_type === "audio") return `[${dir}] <語音>`;
      return `[${dir}] ${(r.text ?? "").slice(0, 200)}`;
    });

    return `\n--- RECENT LINE HISTORY ---\n${lines.join("\n")}`;
  } catch (err) {
    console.error(`[念·萃] DB history query error: ${err}`);
    return "";
  }
}

function extractFlatMessages(messages: unknown[]): Array<{ role: string; text: string }> {
  const result: Array<{ role: string; text: string }> = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;
    if (role !== "user" && role !== "assistant") continue;

    const content = m.content;
    if (typeof content === "string") {
      result.push({ role, text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "text" in block) {
          result.push({ role, text: (block as { text: string }).text });
        }
      }
    }
  }
  return result;
}

function extractTextFromMessages(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;
    if (role !== "user" && role !== "assistant") continue;

    const content = m.content;
    if (typeof content === "string") {
      lines.push(`${role}: ${content.slice(0, 2000)}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "text" in block) {
          lines.push(`${role}: ${(block as { text: string }).text.slice(0, 2000)}`);
        }
      }
    }
  }
  return lines.slice(-30).join("\n");
}

export default function register(api: OpenClawPluginApi) {
  const logger = api.logger;

  api.on("agent_end", async (event, ctx) => {
    const agentId = ctx.agentId;
    const workspaceDir = ctx.workspaceDir;

    if (!agentId || !workspaceDir) {
      return;
    }

    // Only process successful conversations with enough messages
    if (!event.success || !event.messages || event.messages.length < 4) {
      return;
    }

    // --- Record outbound messages to shadow DB (LINE only) ---
    const isLine = ctx.messageProvider === "line" || (ctx.sessionKey ?? "").includes(":line:");
    let lineUserId: string | null = null;

    if (isLine) {
      const parts = (ctx.sessionKey ?? "").split(":");
      lineUserId = parts[parts.length - 1] || null;

      if (lineUserId) {
        const outbound = extractFlatMessages(event.messages).filter((m) => m.role === "assistant");
        if (outbound.length > 0) {
          saveOutboundMessages(lineUserId, outbound);
          logger.debug?.(`[念·萃] saved ${outbound.length} outbound messages for ${lineUserId}`);
        }
      }
    }

    const conversationText = extractTextFromMessages(event.messages);
    if (conversationText.length < 100) {
      return;
    }

    // --- Enrich with DB history (LINE only) ---
    let dbHistory = "";
    if (isLine && lineUserId) {
      dbHistory = getRecentHistory(lineUserId);
    }

    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      // Resolve memory directory — try both multi-agent and single-agent layouts
      const multiAgentMemory = path.join(workspaceDir, "agents", agentId, "memory");
      const singleAgentMemory = path.join(workspaceDir, "memory");

      let memoryDir: string;
      if (fs.existsSync(multiAgentMemory)) {
        memoryDir = multiAgentMemory;
      } else if (fs.existsSync(singleAgentMemory)) {
        memoryDir = singleAgentMemory;
      } else if (fs.existsSync(path.join(workspaceDir, "agents", agentId))) {
        // Agent dir exists but no memory dir yet — create it
        fs.mkdirSync(multiAgentMemory, { recursive: true });
        memoryDir = multiAgentMemory;
      } else {
        logger.debug?.(`[念·萃] no suitable memory dir for ${agentId}`);
        return;
      }

      // Call Haiku for extraction
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        logger.warn("[念·萃] ANTHROPIC_API_KEY not set, skipping extraction");
        return;
      }

      const promptParts = [
        EXTRACTION_PROMPT,
        dbHistory,
        `\n--- CONVERSATION ---\n${conversationText}`,
      ];

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 512,
          messages: [
            {
              role: "user",
              content: promptParts.join("\n"),
            },
          ],
        }),
      });

      if (!response.ok) {
        logger.warn(`[念·萃] Haiku API error: ${response.status}`);
        return;
      }

      const result = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      const extractedText = result.content?.[0]?.text?.trim();

      if (!extractedText || extractedText === "NONE") {
        logger.debug?.(`[念·萃] no facts extracted for ${agentId}`);
        return;
      }

      // Append to episodes.md
      const episodesPath = path.join(memoryDir, "episodes.md");
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 16).replace("T", " ");
      const dateHeader = now.toISOString().slice(0, 10);

      let entry = "";

      // Add date header if this is the first entry today
      const existingContent = fs.existsSync(episodesPath)
        ? fs.readFileSync(episodesPath, "utf-8")
        : "";

      if (!existingContent.includes(`## ${dateHeader}`)) {
        entry += `\n## ${dateHeader}\n`;
      }

      entry += `\n### ${timestamp}\n${extractedText}\n`;

      fs.appendFileSync(episodesPath, entry, "utf-8");

      logger.info(
        `[念·萃] extracted ${extractedText.split("\n").filter((l: string) => l.startsWith("- ")).length} facts for ${agentId}`,
      );
    } catch (err) {
      logger.warn(`[念·萃] extraction failed for ${agentId}: ${err}`);
    }
  });

  logger.info("[念·萃] memory extraction hook registered");
}
