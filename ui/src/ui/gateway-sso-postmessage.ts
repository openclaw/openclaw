import { applySettings, type SettingsHost } from "./app-settings.ts";
import { normalizeOptionalString } from "./string-coerce.ts";

export const GATEWAY_SSO_POST_MESSAGE_TYPE = "openclaw-gateway-token";
export const GATEWAY_SSO_POST_MESSAGE_ACK = "openclaw-gateway-token-ack";

export type GatewaySsoPostMessage = {
  type: typeof GATEWAY_SSO_POST_MESSAGE_TYPE;
  token: string;
  v: 1;
};

export type GatewaySsoPostMessageAck = {
  type: typeof GATEWAY_SSO_POST_MESSAGE_ACK;
  v: 1;
};

type GatewaySsoHost = SettingsHost & {
  sessionKey: string;
  connected?: boolean;
};

export function isAllowedGatewaySsoParentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return true;
    }
    return host === "clusterclaw.ai" || host.endsWith(".clusterclaw.ai");
  } catch {
    return false;
  }
}

export function applyGatewayTokenFromSso(
  host: GatewaySsoHost,
  token: string,
): "applied" | "unchanged" | "invalid" {
  const normalized = normalizeOptionalString(token);
  if (!normalized) {
    return "invalid";
  }
  if (normalized === host.settings.token) {
    return "unchanged";
  }
  applySettings(host, {
    ...host.settings,
    token: normalized,
    sessionKey: "main",
    lastActiveSessionKey: "main",
  });
  host.sessionKey = "main";
  return "applied";
}

function postGatewaySsoAck(event: MessageEvent) {
  const source = event.source;
  if (!source || typeof (source as Window).postMessage !== "function") {
    return;
  }
  const ack: GatewaySsoPostMessageAck = {
    type: GATEWAY_SSO_POST_MESSAGE_ACK,
    v: 1,
  };
  (source as Window).postMessage(ack, event.origin);
}

export function installGatewaySsoPostMessageListener(
  host: GatewaySsoHost,
  opts?: { reconnect?: () => void },
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const onMessage = (event: MessageEvent) => {
    if (!isAllowedGatewaySsoParentOrigin(event.origin)) {
      return;
    }
    const data = event.data as Partial<GatewaySsoPostMessage> | null;
    if (data?.type !== GATEWAY_SSO_POST_MESSAGE_TYPE || data.v !== 1) {
      return;
    }
    if (typeof data.token !== "string") {
      return;
    }
    const result = applyGatewayTokenFromSso(host, data.token);
    if (result === "invalid") {
      return;
    }
    if (result === "applied" && host.connected) {
      opts?.reconnect?.();
    }
    postGatewaySsoAck(event);
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
