/**
 * Dispatch ChannelPlugin — connects OpenClaw to DispatchApp via Supabase.
 *
 * Capabilities:
 * - Outbound: broadcast tokens for smooth streaming + INSERT final messages
 * - Inbound: subscribe to dispatch_chat for user messages via postgres_changes
 * - Sub-agent tracking: hooks write to sub_agent_events for humanized progress
 */
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type {
  ChannelGatewayContext,
  ChannelOutboundContext,
} from "../../../src/channels/plugins/types.adapters.js";
import type { ChannelId } from "../../../src/channels/plugins/types.core.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { OutboundDeliveryResult } from "../../../src/infra/outbound/deliver.js";
import { getDispatchRuntime } from "./runtime.js";
import {
  broadcastTokenDelta,
  broadcastStreamDone,
  persistAssistantMessage,
  cleanupStreamingChannels,
  type StreamingContext,
} from "./streaming.js";

// ─── account resolution ────────────────────────────────────────

export type DispatchAccountConfig = {
  supabaseUrl: string;
  supabaseServiceKey: string;
  defaultUserId?: string;
  enabled?: boolean;
};

export type ResolvedDispatchAccount = {
  accountId: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  defaultUserId?: string;
  enabled: boolean;
};

// Module-level state
let activeSupabase: SupabaseClient | null = null;
let activeUserId: string | undefined;
let inboundChannel: RealtimeChannel | null = null;

export function getActiveUserId(): string | undefined {
  return activeUserId;
}

export function getActiveSupabase(): SupabaseClient | null {
  return activeSupabase;
}

function resolveDispatchConfig(cfg: OpenClawConfig): Record<string, DispatchAccountConfig> {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const dispatch = channels?.dispatch as
    | {
        accounts?: Record<string, DispatchAccountConfig>;
        supabaseUrl?: string;
        supabaseServiceKey?: string;
        defaultUserId?: string;
        enabled?: boolean;
      }
    | undefined;

  if (!dispatch) {
    return {};
  }

  if (dispatch.accounts) {
    return dispatch.accounts;
  }

  // Flat config → treat as "default" account
  if (dispatch.supabaseUrl && dispatch.supabaseServiceKey) {
    return {
      default: {
        supabaseUrl: dispatch.supabaseUrl,
        supabaseServiceKey: dispatch.supabaseServiceKey,
        defaultUserId: dispatch.defaultUserId,
        enabled: dispatch.enabled,
      },
    };
  }

  return {};
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedDispatchAccount {
  const accounts = resolveDispatchConfig(cfg);
  const id = accountId?.trim() || "default";
  const account = accounts[id] ?? accounts.default;

  return {
    accountId: id,
    supabaseUrl: account?.supabaseUrl ?? "",
    supabaseServiceKey: account?.supabaseServiceKey ?? "",
    defaultUserId: account?.defaultUserId,
    enabled: account?.enabled !== false,
  };
}

// ─── channel plugin ────────────────────────────────────────────

export const dispatchChannelPlugin: ChannelPlugin<ResolvedDispatchAccount> = {
  id: "dispatch" as ChannelId,

  meta: {
    id: "dispatch" as ChannelId,
    label: "Dispatch",
    selectionLabel: "Dispatch (DispatchApp)",
    docsPath: "dispatch",
    blurb: "Connect to DispatchApp via Supabase Realtime",
    order: 50,
  },

  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },

  reload: { configPrefixes: ["channels.dispatch"] },

  config: {
    listAccountIds: (cfg) => {
      const keys = Object.keys(resolveDispatchConfig(cfg));
      return keys.length > 0 ? keys : ["default"];
    },
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
    defaultAccountId: () => "default",
    isEnabled: (account) => account.enabled,
    isConfigured: (account) =>
      Boolean(account.supabaseUrl?.trim() && account.supabaseServiceKey?.trim()),
    unconfiguredReason: () => "Missing supabaseUrl or supabaseServiceKey",
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.supabaseUrl && account.supabaseServiceKey),
    }),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 8000,

    sendText: async (ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => {
      if (!activeSupabase || !activeUserId) {
        console.error("[dispatch-channel] sendText called but no active Supabase client or userId");
        return {
          channel: "dispatch" as ChannelId,
          messageId: `dispatch-err-${Date.now()}`,
        };
      }

      const text = ctx.text;

      // Persist the final message to dispatch_chat
      const result = await persistAssistantMessage(activeSupabase, {
        userId: activeUserId,
        content: text,
      });

      // Signal stream done
      const streamCtx: StreamingContext = {
        supabase: activeSupabase,
        userId: activeUserId,
      };
      await broadcastStreamDone(streamCtx).catch((err) => {
        console.error("[dispatch-channel] broadcastStreamDone failed:", err);
      });

      return {
        channel: "dispatch" as ChannelId,
        messageId: result?.id ?? `dispatch-${Date.now()}`,
        chatId: activeUserId,
      };
    },
  },

  gateway: {
    startAccount: async (ctx: ChannelGatewayContext<ResolvedDispatchAccount>) => {
      const { account, cfg, abortSignal, log } = ctx;
      const { createClient } = await import("@supabase/supabase-js");

      log?.info(`[dispatch-channel] Starting account "${account.accountId}"`);
      log?.info(`[dispatch-channel] Supabase URL: ${account.supabaseUrl}`);

      // Create the Supabase client
      const supabase = createClient(account.supabaseUrl, account.supabaseServiceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
        realtime: { params: { eventsPerSecond: 40 } },
      });

      activeSupabase = supabase;
      activeUserId = account.defaultUserId;

      ctx.setStatus({
        accountId: account.accountId,
        enabled: true,
        configured: true,
        running: true,
        connected: true,
        lastConnectedAt: Date.now(),
      });

      // Subscribe to inbound user messages via postgres_changes
      if (account.defaultUserId) {
        log?.info(
          `[dispatch-channel] Subscribing to inbound messages for user ${account.defaultUserId}`,
        );

        inboundChannel = supabase
          .channel("dispatch-inbound")
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "dispatch_chat",
              filter: `user_id=eq.${account.defaultUserId}`,
            },
            (payload) => {
              const row = payload.new as {
                id: string;
                user_id: string;
                role: string;
                content: string;
                run_id?: string;
                created_at: string;
              };

              // Only process user messages — skip our own assistant INSERTs
              if (row.role !== "user") {
                return;
              }

              log?.info(
                `[dispatch-channel] Inbound: "${row.content.slice(0, 80)}${row.content.length > 80 ? "…" : ""}"`,
              );

              // Dispatch through the OpenClaw agent pipeline
              void dispatchInbound({
                userId: row.user_id,
                messageId: row.id,
                content: row.content,
                accountId: account.accountId,
                cfg,
                log,
              });
            },
          )
          .subscribe((status) => {
            log?.info(`[dispatch-channel] Inbound subscription: ${status}`);
            if (String(status) === "SUBSCRIBED") {
              ctx.setStatus({
                ...ctx.getStatus(),
                connected: true,
                lastConnectedAt: Date.now(),
              });
            }
          });
      }

      // Wait for abort signal (channel shutdown)
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log?.info("[dispatch-channel] Received abort, shutting down");
          resolve();
        });
      });

      // Cleanup
      if (inboundChannel) {
        await inboundChannel.unsubscribe();
        inboundChannel = null;
      }
      cleanupStreamingChannels();
      await supabase.removeAllChannels();
      activeSupabase = null;
      activeUserId = undefined;

      ctx.setStatus({
        accountId: account.accountId,
        enabled: true,
        configured: true,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },

    stopAccount: async (ctx) => {
      ctx.log?.info("[dispatch-channel] Stopping account");
      if (inboundChannel) {
        await inboundChannel.unsubscribe();
        inboundChannel = null;
      }
      cleanupStreamingChannels();
      if (activeSupabase) {
        await activeSupabase.removeAllChannels();
        activeSupabase = null;
      }
      activeUserId = undefined;
    },
  },
};

// ─── inbound dispatch ──────────────────────────────────────────

/**
 * Dispatch an inbound user message through the OpenClaw agent pipeline.
 *
 * Builds a MsgContext and calls dispatchReplyWithBufferedBlockDispatcher,
 * the same mechanism used by Telegram, Discord, etc.
 *
 * The `deliver` callback implements dual-channel streaming:
 * - "block" kind → broadcast partial text via Supabase Realtime (smooth streaming)
 * - "final" kind → persist complete message to dispatch_chat + broadcast done
 * - "tool" kind → ignored (tool outputs are handled by sub-agent hooks)
 */
async function dispatchInbound(params: {
  userId: string;
  messageId: string;
  content: string;
  accountId: string;
  cfg: OpenClawConfig;
  log?: { info: (msg: string) => void; error?: (msg: string) => void };
}): Promise<void> {
  try {
    const runtime = getDispatchRuntime();
    const cfg = runtime.config.loadConfig();

    const sessionKey = `dispatch:direct:${params.userId}:${params.accountId}`;

    // Build inbound context (MsgContext + CommandAuthorized = FinalizedMsgContext)
    const ctx = {
      Body: params.content,
      BodyForAgent: params.content,
      BodyForCommands: params.content,
      CommandBody: params.content,
      RawBody: params.content,
      From: params.userId,
      To: "agent",
      SessionKey: sessionKey,
      AccountId: params.accountId,
      MessageSid: params.messageId,
      ChatType: "direct",
      Provider: "dispatch",
      Surface: "dispatch",
      OriginatingChannel: "dispatch" as const,
      OriginatingTo: params.userId,
      Timestamp: Date.now(),
      CommandAuthorized: true,
    };

    // Track the last broadcast text for computing deltas
    let lastBroadcastText = "";

    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          if (!payload.text || !activeSupabase) {
            return;
          }

          if (info.kind === "block") {
            // Block reply = intermediate streaming update
            // Compute the delta from previous text and broadcast it
            const fullText = payload.text;
            if (fullText.length > lastBroadcastText.length) {
              const delta = fullText.slice(lastBroadcastText.length);
              lastBroadcastText = fullText;

              const streamCtx: StreamingContext = {
                supabase: activeSupabase,
                userId: params.userId,
              };
              await broadcastTokenDelta(streamCtx, delta).catch(() => {});
            }
          } else if (info.kind === "final") {
            // Final reply = persist to DB and signal stream done
            await persistAssistantMessage(activeSupabase, {
              userId: params.userId,
              content: payload.text,
            });

            const streamCtx: StreamingContext = {
              supabase: activeSupabase,
              userId: params.userId,
            };
            await broadcastStreamDone(streamCtx).catch(() => {});
            lastBroadcastText = "";
          }
          // "tool" kind payloads are ignored — sub-agent hooks handle tool events
        },
      },
    });

    params.log?.info(`[dispatch-channel] Reply dispatched for ${params.messageId}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch-channel] Inbound dispatch failed: ${errMsg}`);
    params.log?.error?.(`[dispatch-channel] Inbound dispatch failed: ${errMsg}`);
  }
}
