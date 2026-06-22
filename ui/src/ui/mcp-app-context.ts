import type { GatewayBrowserClient } from "./gateway.js";

let _client: GatewayBrowserClient | null = null;
let _sessionKey: string | null = null;

export function setMcpAppContext(client: GatewayBrowserClient | null, sessionKey: string | null) {
  _client = client;
  _sessionKey = sessionKey;
}

export function getMcpAppContext(): {
  client: GatewayBrowserClient | null;
  sessionKey: string | null;
} {
  return { client: _client, sessionKey: _sessionKey };
}
