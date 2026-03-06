/**
 * Plugin hooks for sub-agent event tracking.
 *
 * Registers after_tool_call, subagent_spawned, and subagent_ended hooks
 * that write events to the `sub_agent_events` Supabase table.
 *
 * The DB trigger on sub_agent_events fires the humanize-event edge function
 * which uses Haiku to produce a human-readable progress label.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  PluginHookSubagentSpawnedEvent,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentContext,
} from "../../../src/plugins/types.js";

export type HooksConfig = {
  getSupabase: () => SupabaseClient | null;
  resolveUserId: () => string | undefined;
};

let hooksConfig: HooksConfig | null = null;

export function initHooks(config: HooksConfig): void {
  hooksConfig = config;
}

// ─── helpers ───────────────────────────────────────────────────

function extractAgentLabel(sessionKey?: string): string {
  if (!sessionKey) {
    return "unknown";
  }
  const parts = sessionKey.split(":");
  const subIdx = parts.indexOf("subagent");
  if (subIdx >= 0) {
    return parts.slice(subIdx).join(":");
  }
  return parts.slice(-2).join(":");
}

function isSubagentSession(sessionKey?: string): boolean {
  return Boolean(sessionKey?.includes(":subagent:"));
}

function truncateForJson(obj: unknown, maxLen = 2000): unknown {
  const str = JSON.stringify(obj);
  if (!str || str.length <= maxLen) {
    return obj;
  }
  return { _truncated: true, preview: str.slice(0, maxLen) };
}

/**
 * Insert a sub-agent event into Supabase.
 * Fire-and-forget — errors are logged but never block the agent.
 */
async function insertSubAgentEvent(params: {
  agentLabel: string;
  eventType: "spawn" | "tool_start" | "tool_result" | "complete" | "error";
  toolName?: string;
  rawData?: Record<string, unknown>;
  humanLabel?: string;
}): Promise<void> {
  if (!hooksConfig) {
    return;
  }

  const supabase = hooksConfig.getSupabase();
  if (!supabase) {
    return;
  } // channel not started yet

  const userId = hooksConfig.resolveUserId();
  if (!userId) {
    return;
  }

  try {
    const { error } = await supabase.from("sub_agent_events").insert({
      user_id: userId,
      agent_label: params.agentLabel,
      event_type: params.eventType,
      tool_name: params.toolName ?? null,
      raw_data: params.rawData ?? {},
      human_label: params.humanLabel ?? null,
      status: "pending",
    });

    if (error) {
      console.error(
        `[dispatch-channel] sub_agent_event insert failed (${params.eventType}):`,
        error.message,
      );
    }
  } catch (err) {
    console.error(`[dispatch-channel] sub_agent_event insert threw:`, err);
  }
}

// ─── hook handlers ─────────────────────────────────────────────

/**
 * after_tool_call — fires for every tool call in every session.
 * We filter to only sub-agent sessions (:subagent: in sessionKey).
 */
export async function handleAfterToolCall(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<void> {
  if (!isSubagentSession(ctx.sessionKey)) {
    return;
  }

  const agentLabel = extractAgentLabel(ctx.sessionKey);
  const eventType = event.error ? "error" : event.durationMs != null ? "tool_result" : "tool_start";

  await insertSubAgentEvent({
    agentLabel,
    eventType,
    toolName: event.toolName,
    rawData: {
      params: truncateForJson(event.params),
      durationMs: event.durationMs,
      isError: Boolean(event.error),
      error: event.error,
    },
  });
}

/**
 * subagent_spawned — fires when a sub-agent is created.
 */
export async function handleSubagentSpawned(
  event: PluginHookSubagentSpawnedEvent,
  _ctx: PluginHookSubagentContext,
): Promise<void> {
  const agentLabel = extractAgentLabel(event.childSessionKey);

  await insertSubAgentEvent({
    agentLabel,
    eventType: "spawn",
    rawData: {
      runId: event.runId,
      agentId: event.agentId,
      label: event.label,
      mode: event.mode,
    },
    humanLabel: event.label ? `Starting: ${event.label}` : "Sub-agent started",
  });
}

/**
 * subagent_ended — fires when a sub-agent completes/errors/times out.
 */
export async function handleSubagentEnded(
  event: PluginHookSubagentEndedEvent,
  _ctx: PluginHookSubagentContext,
): Promise<void> {
  const agentLabel = extractAgentLabel(event.targetSessionKey);
  const isError = event.outcome === "error" || event.outcome === "timeout";
  const eventType = isError ? "error" : "complete";

  await insertSubAgentEvent({
    agentLabel,
    eventType,
    rawData: {
      runId: event.runId,
      reason: event.reason,
      outcome: event.outcome,
      error: event.error,
      endedAt: event.endedAt,
    },
    humanLabel: isError ? `Failed: ${event.error ?? event.reason ?? "unknown"}` : "Completed",
  });
}
