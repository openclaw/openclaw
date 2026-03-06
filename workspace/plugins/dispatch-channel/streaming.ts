/**
 * Dual-channel streaming for the Dispatch channel plugin.
 *
 * Two Supabase Realtime modes:
 * 1. **Broadcast** — ephemeral, fast (~50ms), for live token-by-token streaming
 * 2. **Postgres INSERT** — persistent, for final complete messages
 *
 * Token deltas are broadcast to `chat:{userId}` for instant display.
 * When complete, the full text is INSERTed into `dispatch_chat`.
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

export type StreamingContext = {
  supabase: SupabaseClient;
  userId: string;
  runId?: string;
};

// Cache broadcast channels so we reuse per-user
const channelCache = new Map<string, RealtimeChannel>();

function getOrCreateBroadcastChannel(supabase: SupabaseClient, userId: string): RealtimeChannel {
  const key = `chat:${userId}`;
  const existing = channelCache.get(key);
  if (existing) {
    return existing;
  }

  const channel = supabase.channel(key, {
    config: { broadcast: { self: false } },
  });
  channel.subscribe();
  channelCache.set(key, channel);
  return channel;
}

/**
 * Broadcast a single token delta to the user's chat channel.
 * Fire-and-forget — no DB write, ephemeral only.
 */
export async function broadcastTokenDelta(ctx: StreamingContext, delta: string): Promise<void> {
  const channel = getOrCreateBroadcastChannel(ctx.supabase, ctx.userId);
  await channel.send({
    type: "broadcast",
    event: "token",
    payload: { delta, runId: ctx.runId, ts: Date.now() },
  });
}

/**
 * Signal that the message stream is complete.
 * The app uses this to finalize the streaming bubble.
 */
export async function broadcastStreamDone(ctx: StreamingContext): Promise<void> {
  const channel = getOrCreateBroadcastChannel(ctx.supabase, ctx.userId);
  await channel.send({
    type: "broadcast",
    event: "done",
    payload: { runId: ctx.runId, ts: Date.now() },
  });
}

/**
 * Persist the final complete message to the dispatch_chat table.
 * Also triggers postgres_changes for the app to receive.
 */
export async function persistAssistantMessage(
  supabase: SupabaseClient,
  params: {
    userId: string;
    content: string;
    runId?: string;
  },
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("dispatch_chat")
    .insert({
      user_id: params.userId,
      role: "assistant",
      content: params.content,
      run_id: params.runId ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[dispatch-channel] Failed to persist assistant message:", error.message);
    return null;
  }
  return data;
}

/**
 * Clean up broadcast channels on shutdown.
 */
export function cleanupStreamingChannels(): void {
  for (const channel of channelCache.values()) {
    void channel.unsubscribe();
  }
  channelCache.clear();
}
