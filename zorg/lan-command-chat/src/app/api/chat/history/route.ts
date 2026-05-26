import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

import { appConfig } from "@/lib/env";
import { getDbPool } from "@/lib/db";
import { callGateway } from "@/lib/gatewayWs";
import { normalizeMessages } from "@/lib/chat";
import { logAppActivity } from "@/lib/chatIngest";

export const runtime = "nodejs";

type ChatHistoryResponse = {
  messages?: unknown[];
};

type StreamMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: number;
  attachments?: Array<{ name: string; type: string; size: number; url: string; path?: string; containerPath?: string }>;
};

const STREAM_HISTORY_LIMIT = 20;
const DEFAULT_STREAM_SESSION_KEYS = [
  appConfig.sessionKey,
  "agent:main:main",
  "agent:main:telegram:default:direct:8481435159",
];

function streamSessionKeys() {
  const configured = process.env.CHAT_STREAM_SESSION_KEYS?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return [...new Set([...configured, ...DEFAULT_STREAM_SESSION_KEYS].filter(Boolean))];
}

async function loadGatewaySessionHistory(sessionKey: string): Promise<StreamMessage[]> {
  const raw = await callGateway<ChatHistoryResponse>({
    method: "chat.history",
    params: {
      sessionKey,
      limit: Math.max(STREAM_HISTORY_LIMIT * 2, appConfig.historyLimit),
    },
    timeoutMs: appConfig.gatewayTimeoutMs,
  });

  return normalizeMessages(raw?.messages ?? []).map((message, index) => ({
    ...message,
    id: `${sessionKey}:${message.id || index}`,
  }));
}

async function loadGatewayHistory() {
  const batches = await Promise.allSettled(streamSessionKeys().map((sessionKey) => loadGatewaySessionHistory(sessionKey)));
  return batches.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

function extractTranscriptText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: string };
      if (typed.type && typed.type !== "text") return "";
      return typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseAttachmentSummary(value: unknown): StreamMessage["attachments"] {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const attachments = parsed
      .map((file) => ({
        name: typeof file?.name === "string" ? file.name : "file",
        type: typeof file?.type === "string" ? file.type : "application/octet-stream",
        size: typeof file?.size === "number" ? file.size : 0,
        url: typeof file?.url === "string" ? file.url : "",
        path: typeof file?.path === "string" ? file.path : undefined,
        containerPath: typeof file?.containerPath === "string" ? file.containerPath : undefined,
      }))
      .filter((file) => file.url || file.path || file.containerPath);
    return attachments.length ? attachments : undefined;
  } catch {
    return undefined;
  }
}

function transcriptSessionKey(jsonlPath: string) {
  const trajectoryPath = jsonlPath.replace(/\.jsonl$/, ".trajectory.jsonl");
  try {
    const firstLine = fs.readFileSync(trajectoryPath, "utf8").split("\n").find(Boolean);
    if (!firstLine) return "";
    const parsed = JSON.parse(firstLine) as { sessionKey?: string };
    return typeof parsed.sessionKey === "string" ? parsed.sessionKey : "";
  } catch {
    return "";
  }
}

function includeTranscriptSession(sessionKey: string) {
  return (
    sessionKey === "agent:main:main" ||
    sessionKey === appConfig.sessionKey ||
    sessionKey.includes(":telegram:") ||
    sessionKey.includes(":direct:")
  );
}

function loadTranscriptHistory(): StreamMessage[] {
  const sessionsDir = path.join(process.env.HOME || "/home/openclaw", ".openclaw/agents/main/sessions");
  try {
    return fs
      .readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl"))
      .map((name) => path.join(sessionsDir, name))
      .map((filePath) => ({ filePath, stat: fs.statSync(filePath), sessionKey: transcriptSessionKey(filePath) }))
      .filter((item) => includeTranscriptSession(item.sessionKey))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 10)
      .flatMap((item) => {
        const lines = fs.readFileSync(item.filePath, "utf8").trim().split("\n").filter(Boolean).slice(-120);
        return lines.flatMap((line, index) => {
          try {
            const parsed = JSON.parse(line) as {
              type?: string;
              id?: string;
              timestamp?: string;
              message?: { role?: string; content?: unknown; timestamp?: number };
            };
            const message = parsed.message;
            const role = message?.role;
            if (parsed.type !== "message" || !message || (role !== "user" && role !== "assistant" && role !== "system")) return [];
            const text = extractTranscriptText(message.content);
            if (!text || text === "NO_REPLY" || text === "HEARTBEAT_OK" || text.startsWith("[cron:")) return [];
            return [{
              id: `${item.sessionKey}:${parsed.id || index}`,
              role: role as StreamMessage["role"],
              text,
              timestamp: message.timestamp ?? (parsed.timestamp ? new Date(parsed.timestamp).getTime() : undefined),
            }];
          } catch {
            return [];
          }
        });
      });
  } catch {
    return [];
  }
}

async function loadDbHistory(): Promise<StreamMessage[] | null> {
  const pool = getDbPool();
  if (!pool) return null;

  const { rows } = await pool.query<{
    memory_key: string | null;
    memory_value: string | null;
    logged_at: Date | string | null;
  }>(
    `
      SELECT memory_key, memory_value, logged_at
      FROM zorg_memory
      WHERE memory_category IN ('chat_ingest_user', 'chat_ingest_assistant', 'chat_project_user', 'chat_project_assistant')
      ORDER BY logged_at DESC
      LIMIT $1
    `,
    [Math.max(STREAM_HISTORY_LIMIT * 3, appConfig.historyLimit)],
  );

  return rows
    .map((row, index) => {
      if (!row.memory_value) return null;
      try {
        const parsed = JSON.parse(row.memory_value) as {
          role?: "user" | "assistant" | "system";
          message?: string;
          attachmentSummary?: string | null;
          timestamp?: number | null;
        };
        const attachments = parseAttachmentSummary(parsed?.attachmentSummary);
        if ((!parsed?.message && !attachments?.length) || (parsed.role !== "user" && parsed.role !== "assistant" && parsed.role !== "system")) return null;
        return {
          id: row.memory_key || `db-${index}`,
          role: parsed.role,
          text: parsed.message || "Attached files",
          attachments,
          timestamp: parsed.timestamp ?? (row.logged_at ? new Date(row.logged_at).getTime() : undefined),
        };
      } catch {
        return null;
      }
    })
    .filter((message): message is NonNullable<typeof message> => Boolean(message))
    .reverse();
}

function unifiedLatest(messages: StreamMessage[] | null) {
  const seen = new Set<string>();
  return (messages ?? [])
    .map((message, index) => ({ ...message, sortTime: message.timestamp ?? index }))
    .sort((a, b) => a.sortTime - b.sortTime)
    .filter((message) => {
      const key = `${message.role}:${message.timestamp ?? ""}:${message.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-STREAM_HISTORY_LIMIT)
    .map(({ sortTime: _sortTime, ...message }) => message);
}

export async function GET() {
  try {
    const [gatewayResult, dbResult] = await Promise.allSettled([loadGatewayHistory(), loadDbHistory()]);
    const gatewayMessages = gatewayResult.status === "fulfilled" ? gatewayResult.value : [];
    const dbMessages = dbResult.status === "fulfilled" ? dbResult.value ?? [] : [];
    const transcriptMessages = loadTranscriptHistory();
    const messages = unifiedLatest([...dbMessages, ...gatewayMessages, ...transcriptMessages]);

    await logAppActivity({
      activityKey: `history:${Date.now()}:unified`,
      activityType: "chat_history",
    });

    return NextResponse.json({
      messages,
      source: "unified",
      limit: STREAM_HISTORY_LIMIT,
      sources: {
        gateway: gatewayMessages.length,
        db: dbMessages.length,
        transcripts: transcriptMessages.length,
      },
      degraded: gatewayResult.status === "rejected" || dbResult.status === "rejected",
    });
  } catch (error) {
    console.error("chat.history unified load failed", error);

    try {
      const dbMessages = await loadDbHistory();
      return NextResponse.json({ messages: unifiedLatest(dbMessages ?? []), source: "db", degraded: true, limit: STREAM_HISTORY_LIMIT });
    } catch (fallbackError) {
      console.error("chat.history db fallback failed", fallbackError);
      return NextResponse.json({ error: "Failed to load chat history" }, { status: 500 });
    }
  }
}
