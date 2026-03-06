/**
 * Dispatch Channel Plugin — Entry Point
 *
 * Registers the "dispatch" channel and sub-agent tracking hooks.
 * Connects OpenClaw to DispatchApp via Supabase Realtime.
 *
 * Data flow:
 * - Outbound text → broadcast tokens (ephemeral) + INSERT dispatch_chat (persistent)
 * - Inbound messages → subscribe dispatch_chat postgres_changes for role='user'
 * - Sub-agent events → after_tool_call/subagent_spawned/subagent_ended → INSERT sub_agent_events
 */
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { dispatchChannelPlugin, getActiveSupabase, getActiveUserId } from "./channel.js";
import {
  initHooks,
  handleAfterToolCall,
  handleSubagentSpawned,
  handleSubagentEnded,
} from "./hooks.js";
import { setDispatchRuntime } from "./runtime.js";

const plugin = {
  id: "dispatch-channel",
  name: "Dispatch Channel",
  description: "Dispatch channel plugin — connects OpenClaw to DispatchApp via Supabase Realtime",
  version: "0.1.0",

  configSchema: {
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  },

  register(api: OpenClawPluginApi) {
    const logger = api.logger;
    logger.info("[dispatch-channel] Registering Dispatch channel plugin");

    // Store the plugin runtime so startAccount can access dispatch functions
    setDispatchRuntime(api.runtime);

    // Register the channel
    api.registerChannel({ plugin: dispatchChannelPlugin });

    // Initialize hooks — use getters so they resolve lazily after startAccount
    initHooks({
      getSupabase: () => getActiveSupabase(),
      resolveUserId: () => getActiveUserId(),
    });

    // Register sub-agent tracking hooks
    api.on("after_tool_call", handleAfterToolCall);
    api.on("subagent_spawned", handleSubagentSpawned);
    api.on("subagent_ended", handleSubagentEnded);

    logger.info("[dispatch-channel] Dispatch channel plugin registered");
  },
};

export default plugin;
