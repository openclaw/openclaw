import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

type GatewayResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message?: string };
};

type GatewayConfig = {
  url: string;
  token?: string;
  password?: string;
};

type DeviceAuthStore = {
  version?: number;
  deviceId?: string;
  tokens?: Record<string, { token?: string; role?: string; scopes?: string[] }>;
};

type DeviceIdentity = {
  version?: number;
  deviceId?: string;
  publicKeyPem?: string;
  privateKeyPem?: string;
  createdAtMs?: number;
};

const PROTOCOL_VERSION = 4;
const DEVICE_AUTH_PATH = `${process.env.HOME}/.openclaw/identity/device-auth.json`;
const DEVICE_IDENTITY_PATH = `${process.env.HOME}/.openclaw/identity/device.json`;

function loadGatewayConfig(): GatewayConfig {
  const raw = fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8");
  const json = JSON.parse(raw);

  const port = json.gateway?.port ?? 18789;
  const host = process.env.GATEWAY_HOST?.trim() || "127.0.0.1";

  return {
    url: `ws://${host}:${port}`,
    token: typeof json.gateway?.auth?.token === "string" ? json.gateway.auth.token : undefined,
    password: typeof json.gateway?.auth?.password === "string" ? json.gateway.auth.password : undefined,
  };
}

function loadOperatorDeviceToken(): string | null {
  try {
    const raw = fs.readFileSync(DEVICE_AUTH_PATH, "utf8");
    const json = JSON.parse(raw) as DeviceAuthStore;
    const token = json?.tokens?.operator?.token;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function loadDeviceIdentity(): DeviceIdentity | null {
  try {
    const raw = fs.readFileSync(DEVICE_IDENTITY_PATH, "utf8");
    const json = JSON.parse(raw) as DeviceIdentity;
    if (!json?.deviceId || !json?.publicKeyPem) return null;
    return json;
  } catch {
    return null;
  }
}

export async function callGateway<T = unknown>(opts: {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  const { url, token, password } = loadGatewayConfig();
  const timeoutMs = opts.timeoutMs ?? 15000;
  const deviceToken = token || password ? null : loadOperatorDeviceToken();
  const deviceIdentity = token || password ? null : loadDeviceIdentity();

  if (!token && !password && !deviceToken) {
    throw new Error("Gateway auth token not found");
  }

  if (!token && !password && !deviceIdentity) {
    throw new Error("Device identity not found");
  }

  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(url);
    const connectId = randomUUID();
    const requestId = randomUUID();
    let timeout: NodeJS.Timeout | null = null;

    const cleanup = (err?: Error, payload?: T) => {
      if (timeout) clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(payload as T);
    };

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "gateway-client",
              version: "lan-chat",
              platform: "node",
              mode: "backend",
            },
            auth: token ? { token } : password ? { password } : { deviceToken },
            ...(deviceIdentity
              ? {
                  device: {
                    id: deviceIdentity.deviceId,
                    publicKey: deviceIdentity.publicKeyPem,
                  },
                }
              : {}),
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: [],
          },
        }),
      );
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as GatewayResponse;

      if (msg.type === "res" && msg.id === connectId) {
        if (!msg.ok) {
          cleanup(new Error(msg.error?.message ?? "connect failed"));
          return;
        }

        ws.send(
          JSON.stringify({
            type: "req",
            id: requestId,
            method: opts.method,
            params: opts.params ?? {},
          }),
        );
        return;
      }

      if (msg.type === "res" && msg.id === requestId) {
        if (!msg.ok) {
          cleanup(new Error(msg.error?.message ?? "request failed"));
          return;
        }
        cleanup(undefined, msg.payload as T);
      }
    });

    ws.on("error", (err) => cleanup(err as Error));

    timeout = setTimeout(() => {
      cleanup(new Error("Gateway timeout"));
    }, timeoutMs);
  });
}
