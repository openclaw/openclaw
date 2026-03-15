import { buildDeviceAuthPayload } from "../../../src/gateway/device-auth.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../src/gateway/protocol/client-info.js";
import {
  ConnectErrorDetailCodes,
  readConnectErrorRecoveryAdvice,
  readConnectErrorDetailCode,
} from "../../../src/gateway/protocol/connect-error-details.js";
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./device-identity.ts";
import { generateUUID } from "./uuid.ts";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type GatewayErrorInfo = {
  code: string;
  message: string;
  details?: unknown;
};

export class GatewayRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;

  constructor(error: GatewayErrorInfo) {
    super(error.message);
    this.name = "GatewayRequestError";
    this.gatewayCode = error.code;
    this.details = error.details;
  }
}

export function resolveGatewayErrorDetailCode(
  error: { details?: unknown } | null | undefined,
): string | null {
  return readConnectErrorDetailCode(error?.details);
}

/**
 * Auth errors that won't resolve without user action — don't auto-reconnect.
 *
 * NOTE: AUTH_TOKEN_MISMATCH is intentionally NOT included here because the
 * browser client supports a bounded one-time retry with a cached device token
 * when the endpoint is trusted. Reconnect suppression for mismatch is handled
 * with client state (after retry budget is exhausted).
 */
export function isNonRecoverableAuthError(error: GatewayErrorInfo | undefined): boolean {
  if (!error) {
    return false;
  }
  const code = resolveGatewayErrorDetailCode(error);
  return (
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
    code === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED
  );
}

function isTrustedRetryEndpoint(url: string): boolean {
  try {
    const gatewayUrl = new URL(url, window.location.href);
    const host = gatewayUrl.hostname.trim().toLowerCase();
    const isLoopbackHost =
      host === "localhost" || host === "::1" || host === "[::1]" || host === "127.0.0.1";
    const isLoopbackIPv4 = host.startsWith("127.");
    if (isLoopbackHost || isLoopbackIPv4) {
      return true;
    }
    const pageUrl = new URL(window.location.href);
    return gatewayUrl.host === pageUrl.host;
  } catch {
    return false;
  }
}

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: {
    version?: string;
    connId?: string;
  };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth?: {
    deviceToken?: string;
    role?: string;
    scopes?: string[];
    issuedAtMs?: number;
  };
  policy?: { tickIntervalMs?: number };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

type SelectedConnectAuth = {
  authToken?: string;
  authDeviceToken?: string;
  authPassword?: string;
  resolvedDeviceToken?: string;
  storedToken?: string;
  canFallbackToShared: boolean;
};

export type GatewayBrowserClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: { code: number; reason: string; error?: GatewayErrorInfo }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: number | null = null;
  private backoffMs = 800;
  private pendingConnectError: GatewayErrorInfo | undefined;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;

  constructor(private opts: GatewayBrowserClientOptions) {}

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.pendingConnectError = undefined;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) {
      return;
    }
    this.ws = new WebSocket(this.opts.url);
    this.ws.addEventListener("open", () => this.queueConnect());
    this.ws.addEventListener("message", (ev) => this.handleMessage(String(ev.data ?? "")));
    this.ws.addEventListener("close", (ev) => {
      const reason = String(ev.reason ?? "");
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason, error: connectError });
      const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
      if (
        connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH &&
        this.deviceTokenRetryBudgetUsed &&
        !this.pendingDeviceTokenRetry
      ) {
        return;
      }
      if (!isNonRecoverableAuthError(connectError)) {
        this.scheduleReconnect();
      }
    });
    this.ws.addEventListener("error", () => {
      // ignored; close handler will fire
    });
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    window.setTimeout(() => this.connect(), delay);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private async sendConnect() {
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    // Gateways may reject this unless gateway.controlUi.allowInsecureAuth is enabled.
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;

    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
    const role = "operator";
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let selectedAuth: SelectedConnectAuth = {
      authToken: explicitGatewayToken,
      authPassword: explicitPassword,
      canFallbackToShared: false,
    };

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      selectedAuth = this.selectConnectAuth({
        role,
        deviceId: deviceIdentity.deviceId,
      });
      if (this.pendingDeviceTokenRetry && selectedAuth.authDeviceToken) {
        this.pendingDeviceTokenRetry = false;
      }
    } else {
      // In insecure context (HTTP/LAN), skip device identity but still use
      // explicit token/password if provided. Gateways may reject this unless
      // gateway.controlUi.allowInsecureAuth is enabled.
      const explicitToken = this.opts.token?.trim() || undefined;
      const explicitPassword = this.opts.password?.trim() || undefined;
      selectedAuth = {
        authToken: explicitToken,
        authPassword: explicitPassword,
        canFallbackToShared: false,
      };
    }
    const authToken = selectedAuth.authToken;
    const deviceToken = selectedAuth.authDeviceToken ?? selectedAuth.resolvedDeviceToken;
    const auth =
      authToken || selectedAuth.authPassword
        ? {
            token: authToken,
            deviceToken,
            password: selectedAuth.authPassword,
          }
        : undefined;

    let device:
      | {
          id: string;
          publicKey: string;
          signature: string;
          signedAt: number;
          nonce: string;
        }
      | undefined;

    if (isSecureContext && deviceIdentity) {
      const signedAtMs = Date.now();
      const nonce = this.connectNonce ?? "";
      const payload = buildDeviceAuthPayload({
        deviceId: deviceIdentity.deviceId,
        clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
        clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
        role,
        scopes,
        signedAtMs,
        token: authToken ?? null,
        nonce,
      });
      const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
      device = {
        id: deviceIdentity.deviceId,
        publicKey: deviceIdentity.publicKey,
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: this.opts.clientVersion ?? "control-ui",
        platform: this.opts.platform ?? navigator.platform ?? "web",
        mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
        instanceId: this.opts.instanceId,
      },
      role,
      scopes,
      device,
      caps: ["tool-events"],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    void this.request<GatewayHelloOk>("connect", params)
      .then((hello) => {
        this.pendingDeviceTokenRetry = false;
        this.deviceTokenRetryBudgetUsed = false;
        if (hello?.auth?.deviceToken && deviceIdentity) {
          storeDeviceAuthToken({
            deviceId: deviceIdentity.deviceId,
            role: hello.auth.role ?? role,
            token: hello.auth.deviceToken,
            scopes: hello.auth.scopes ?? [],
          });
        }
        this.backoffMs = 800;
        this.opts.onHello?.(hello);
      })
      .catch((err: unknown) => {
        const connectErrorCode =
          err instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(err) : null;
        const recoveryAdvice =
          err instanceof GatewayRequestError ? readConnectErrorRecoveryAdvice(err.details) : {};
        const retryWithDeviceTokenRecommended =
          recoveryAdvice.recommendedNextStep === "retry_with_device_token";
        const canRetryWithDeviceTokenHint =
          recoveryAdvice.canRetryWithDeviceToken === true ||
          retryWithDeviceTokenRecommended ||
          connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
        const shouldRetryWithDeviceToken =
          !this.deviceTokenRetryBudgetUsed &&
          !selectedAuth.authDeviceToken &&
          Boolean(explicitGatewayToken) &&
          Boolean(deviceIdentity) &&
          Boolean(selectedAuth.storedToken) &&
          canRetryWithDeviceTokenHint &&
          isTrustedRetryEndpoint(this.opts.url);
        if (shouldRetryWithDeviceToken) {
          this.pendingDeviceTokenRetry = true;
          this.deviceTokenRetryBudgetUsed = true;
        }
        if (err instanceof GatewayRequestError) {
          this.pendingConnectError = {
            code: err.gatewayCode,
            message: err.message,
            details: err.details,
          };
        } else {
          this.pendingConnectError = undefined;
        }
        if (
          selectedAuth.canFallbackToShared &&
          deviceIdentity &&
          connectErrorCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
        ) {
          clearDeviceAuthToken({ deviceId: deviceIdentity.deviceId, role });
        }
        this.ws?.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
      });
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new GatewayRequestError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
          }),
        );
      }
      return;
    }
  }

  private selectConnectAuth(params: { role: string; deviceId: string }): SelectedConnectAuth {
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const authPassword = this.opts.password?.trim() || undefined;
    const storedToken = loadDeviceAuthToken({
      deviceId: params.deviceId,
      role: params.role,
    })?.token;
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry &&
      Boolean(explicitGatewayToken) &&
      Boolean(storedToken) &&
      isTrustedRetryEndpoint(this.opts.url);
    const resolvedDeviceToken = !(explicitGatewayToken || authPassword)
      ? (storedToken ?? undefined)
      : undefined;
    const authToken = explicitGatewayToken ?? resolvedDeviceToken;
    return {
      authToken,
      authDeviceToken: shouldUseDeviceRetryToken ? (storedToken ?? undefined) : undefined,
      authPassword,
      resolvedDeviceToken,
      storedToken: storedToken ?? undefined,
      canFallbackToShared: Boolean(storedToken && explicitGatewayToken),
    };
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = generateUUID();
    const frame = { type: "req", id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }

  private queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
    }
    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect();
    }, 750);
  }
}
