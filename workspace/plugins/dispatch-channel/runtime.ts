/**
 * Plugin runtime accessor — follows the Discord extension pattern.
 *
 * The PluginRuntime is stored during plugin registration (index.ts register())
 * and accessed later in gateway.startAccount() for inbound dispatch.
 */
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";

let pluginRuntime: PluginRuntime | null = null;

export function setDispatchRuntime(runtime: PluginRuntime): void {
  pluginRuntime = runtime;
}

export function getDispatchRuntime(): PluginRuntime {
  if (!pluginRuntime) {
    throw new Error("[dispatch-channel] Plugin runtime not initialized");
  }
  return pluginRuntime;
}
