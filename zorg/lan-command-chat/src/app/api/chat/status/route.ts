import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { appConfig } from "@/lib/env";
import { callGateway } from "@/lib/gatewayWs";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "/home/openclaw/.npm-global/bin/openclaw";
const STATUS_TIMEOUT_MS = Math.max(appConfig.statusTimeoutMs, 12_000);

type SessionSummary = {
  agentId?: string;
  channel?: string;
  key?: string;
  kind?: string;
  label?: string;
  displayName?: string;
  model?: string;
  modelProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  remainingTokens?: number;
  percentUsed?: number;
  contextTokens?: number;
  updatedAt?: number;
  thinking?: string;
  thinkingDefault?: string;
  thinkingLevel?: string;
  sessionId?: string;
  status?: string;
  hasActiveRun?: boolean;
  totalTokensFresh?: boolean;
  lastChannel?: string;
  origin?: {
    provider?: string;
    surface?: string;
    chatType?: string;
  };
};

type StatusPayload = {
  sessions?:
    | SessionSummary[]
    | {
        recent?: SessionSummary[];
        sessions?: SessionSummary[];
        defaults?: {
          model?: string;
          contextTokens?: number;
          thinking?: string;
          thinkingDefault?: string;
        };
      };
  defaults?: {
    model?: string;
    contextTokens?: number;
    thinking?: string;
    thinkingDefault?: string;
  };
};

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cleanText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function sessionTokens(session: SessionSummary | undefined) {
  if (!session) return 0;
  return asNumber(session.totalTokens) || asNumber(session.inputTokens) + asNumber(session.outputTokens);
}

function isRelevantCommandSession(session: SessionSummary) {
  const key = cleanText(session.key);
  const provider = cleanText(session.origin?.provider);
  return (
    key === appConfig.sessionKey ||
    key === "agent:main:main" ||
    key === "agent:main:telegram:default:direct:8481435159" ||
    provider === "webchat" ||
    cleanText(session.channel) === "telegram" ||
    cleanText(session.lastChannel) === "webchat"
  );
}

function sessionTelemetryScore(session: SessionSummary) {
  const key = cleanText(session.key);
  let score = asNumber(session.updatedAt);
  if (key === appConfig.sessionKey) score += 25_000;
  if (key === "agent:main:main") score += 20_000;
  if (key === "agent:main:telegram:default:direct:8481435159") score += 10_000;
  if (session.hasActiveRun || session.status === "running") score += 60_000;
  if (session.totalTokensFresh) score += 5_000;
  if (sessionTokens(session) > 0) score += 3_000;
  return score;
}

function pickSession(sessions: SessionSummary[]) {
  const relevant = sessions.filter(isRelevantCommandSession);
  const candidates = relevant.length ? relevant : sessions;
  return [...candidates].sort((a, b) => sessionTelemetryScore(b) - sessionTelemetryScore(a))[0];
}

function modelLabel(session: SessionSummary | undefined, defaults: StatusPayload["sessions"] extends infer S ? S extends { defaults?: infer D } ? D : never : never) {
  const model = cleanText(session?.model) || cleanText(defaults?.model) || cleanText(process.env.OPENCLAW_MODEL) || cleanText(process.env.MODEL);
  const provider = cleanText(session?.modelProvider);
  return provider && model && !model.includes("/") ? `${provider}/${model}` : model || "unknown";
}

function sessionFileThinking(session: SessionSummary | undefined) {
  const sessionId = cleanText(session?.sessionId);
  if (!sessionId) return "";

  const filePath = path.join(process.env.HOME || "/home/openclaw", ".openclaw", "agents", "main", "sessions", `${sessionId}.jsonl`);
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i]?.includes("thinkingLevel")) continue;
      const parsed = JSON.parse(lines[i]);
      const level = cleanText(parsed?.thinkingLevel);
      if (level) return level;
    }
  } catch {
    // Best effort only. The gateway/CLI payload remains the primary status source.
  }

  return "";
}

function thinkingLabel(session: SessionSummary | undefined, defaults: StatusPayload["sessions"] extends infer S ? S extends { defaults?: infer D } ? D : never : never) {
  return (
    cleanText(session?.thinking) ||
    cleanText(session?.thinkingLevel) ||
    sessionFileThinking(session) ||
    cleanText(defaults?.thinking) ||
    cleanText(process.env.OPENCLAW_THINKING) ||
    cleanText(process.env.THINKING) ||
    cleanText(session?.thinkingDefault) ||
    cleanText(defaults?.thinkingDefault) ||
    "unknown"
  );
}

function statusFromPayload(payload: StatusPayload, degraded = false) {
  const sessionPayload = payload?.sessions;
  const sessions = Array.isArray(sessionPayload)
    ? sessionPayload
    : Array.isArray(sessionPayload?.sessions)
      ? sessionPayload.sessions
      : Array.isArray(sessionPayload?.recent)
        ? sessionPayload.recent
        : [];
  const target = pickSession(sessions);
  const mainSession = sessions.find((session) => session.key === "agent:main:main");
  const directSession = sessions.find((session) => session.key === "agent:main:telegram:default:direct:8481435159");
  const thinkingTarget = sessionFileThinking(target) ? target : sessionFileThinking(mainSession) ? mainSession : sessionFileThinking(directSession) ? directSession : target;
  const defaults = (Array.isArray(sessionPayload) ? payload?.defaults : sessionPayload?.defaults) || payload?.defaults || {};
  const inputTokens = asNumber(target?.inputTokens);
  const outputTokens = asNumber(target?.outputTokens);
  const tokensUsed = asNumber(target?.totalTokens) || inputTokens + outputTokens;
  const tokensLimit = asNumber(target?.contextTokens) || asNumber(defaults?.contextTokens);
  const tokensPercent = typeof target?.percentUsed === "number" ? target.percentUsed : tokensLimit ? Math.round((tokensUsed / tokensLimit) * 100) : 0;

  return {
    sessionKey: target?.key || appConfig.sessionKey,
    label: target?.key === appConfig.sessionKey ? "lan-chat" : target?.kind || "main",
    model: modelLabel(target, defaults),
    thinking: thinkingLabel(thinkingTarget, defaults),
    tokensUsed,
    inputTokens,
    outputTokens,
    tokensLimit,
    tokensPercent,
    agentId: target?.agentId || "main",
    updatedAt: target?.updatedAt || null,
    degraded: degraded || !target,
  };
}

async function loadGatewayStatus() {
  const payload = await callGateway<StatusPayload>({ method: "sessions.list", params: { limit: 100 }, timeoutMs: STATUS_TIMEOUT_MS });
  return statusFromPayload(payload);
}

async function loadCliStatus() {
  const { stdout } = await execFileAsync(OPENCLAW_BIN, ["status", "--json", "--timeout", String(STATUS_TIMEOUT_MS)], {
    timeout: STATUS_TIMEOUT_MS + 3_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return statusFromPayload(JSON.parse(stdout) as StatusPayload, true);
}

function fallbackStatus() {
  return {
    sessionKey: appConfig.sessionKey,
    label: "main",
    model: cleanText(process.env.OPENCLAW_MODEL) || cleanText(process.env.MODEL) || "unknown",
    thinking: cleanText(process.env.OPENCLAW_THINKING) || cleanText(process.env.THINKING) || "unknown",
    tokensUsed: 0,
    tokensLimit: 0,
    tokensPercent: 0,
    agentId: "main",
    degraded: true,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await loadGatewayStatus(), { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (gatewayError) {
    console.error("gateway chat status failed", gatewayError);
  }

  try {
    return NextResponse.json(await loadCliStatus(), { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (cliError) {
    console.error("cli chat status failed", cliError);
    return NextResponse.json(fallbackStatus(), { headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
