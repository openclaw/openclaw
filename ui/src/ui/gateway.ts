/**
 * Gateway 客户端模块
 * 
 * 本模块实现了浏览器端的 Gateway WebSocket 客户端，用于与 OpenClaw Gateway 服务器通信。
 * Gateway 是 OpenClaw 系统的核心组件，负责处理客户端与服务器之间的实时通信。
 */

// 导入设备认证载荷构建函数
import { buildDeviceAuthPayload } from "../../../src/gateway/device-auth.js";
// 导入 Gateway 客户端模式和名称常量
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../src/gateway/protocol/client-info.js";
// 导入连接错误详情相关函数
import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  readConnectErrorRecoveryAdvice,
  readConnectErrorDetailCode,
} from "../../../src/gateway/protocol/connect-error-details.js";
// 导入设备认证令牌的加载、存储和清除函数
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
// 导入设备身份加载和签名函数
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./device-identity.ts";
// 导入 UUID 生成函数
import { generateUUID } from "./uuid.ts";

// ============ 类型定义 ============

/**
 * Gateway 事件帧类型
 * 表示从 Gateway 服务器接收的事件消息
 */
export type GatewayEventFrame = {
  // 消息类型：事件
  type: "event";
  // 事件名称
  event: string;
  // 事件载荷（可选）
  payload?: unknown;
  // 序列号（可选），用于消息排序
  seq?: number;
  // 状态版本信息（可选）
  stateVersion?: { presence: number; health: number };
};

/**
 * Gateway 响应帧类型
 * 表示对请求的响应消息
 */
export type GatewayResponseFrame = {
  // 消息类型：响应
  type: "res";
  // 请求 ID
  id: string;
  // 请求是否成功
  ok: boolean;
  // 响应载荷（可选）
  payload?: unknown;
  // 错误信息（可选）
  error?: {
    // 错误代码
    code: string;
    // 错误消息
    message: string;
    // 错误详情（可选）
    details?: unknown;
    // 是否可重试（可选）
    retryable?: boolean;
    // 重试前等待毫秒数（可选）
    retryAfterMs?: number;
  };
};

/**
 * Gateway 错误信息类型
 * 描述 Gateway 请求过程中发生的错误
 */
export type GatewayErrorInfo = {
  // 错误代码
  code: string;
  // 错误消息
  message: string;
  // 错误详情（可选）
  details?: unknown;
  // 是否可重试（可选）
  retryable?: boolean;
  // 重试前等待毫秒数（可选）
  retryAfterMs?: number;
};

// ============ 错误类定义 ============

/**
 * Gateway 请求错误类
 * 当 Gateway 请求失败时抛出此错误
 */
export class GatewayRequestError extends Error {
  // Gateway 错误代码
  readonly gatewayCode: string;
  // 错误详情（可选）
  readonly details?: unknown;
  // 是否可重试
  readonly retryable: boolean;
  // 重试前等待毫秒数（可选）
  readonly retryAfterMs?: number;

  /**
   * 构造函数
   * @param error - 错误信息对象
   */
  constructor(error: GatewayErrorInfo) {
    // 调用父类构造函数，格式化错误消息
    super(formatConnectErrorMessage({ message: error.message, details: error.details }));
    this.name = "GatewayRequestError";
    this.gatewayCode = error.code;
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

/**
 * 解析 Gateway 错误详情代码
 * @param error - 包含 details 的错误对象
 * @returns 错误代码或 null
 */
export function resolveGatewayErrorDetailCode(
  error: { details?: unknown } | null | undefined,
): string | null {
  return readConnectErrorDetailCode(error?.details);
}

/**
 * 判断是否为不可恢复的认证错误
 * 
 * 这些错误不会通过自动重连解决，需要用户采取行动。
 * 注意：AUTH_TOKEN_MISMATCH 故意不包含在此列表中，
 * 因为浏览器客户端在信任的端点支持使用缓存设备令牌的一次性重试。
 * 不匹配的重新连接抑制通过客户端状态处理（重试预算耗尽后）。
 * 
 * @param error - Gateway 错误信息
 * @returns 是否为不可恢复的认证错误
 */
export function isNonRecoverableAuthError(error: GatewayErrorInfo | undefined): boolean {
  // 如果没有错误，返回 false
  if (!error) {
    return false;
  }
  // 解析错误代码
  const code = resolveGatewayErrorDetailCode(error);
  // 检查是否属于不可恢复的认证错误类型
  return (
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
    code === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED
  );
}

/**
 * 检查 URL 是否为可信的重试端点
 * 
 * 可信端点包括：
 * - localhost 和环回地址 (127.x.x.x)
 * - 与页面 URL 同源的 Gateway URL
 * 
 * @param url - Gateway URL
 * @returns 是否为可信端点
 */
function isTrustedRetryEndpoint(url: string): boolean {
  try {
    // 解析 Gateway URL
    const gatewayUrl = new URL(url, window.location.href);
    const host = gatewayUrl.hostname.trim().toLowerCase();
    // 检查是否为本机环回地址
    const isLoopbackHost =
      host === "localhost" || host === "::1" || host === "[::1]" || host === "127.0.0.1";
    // 检查是否为环回 IPv4 地址 (127.x.x.x)
    const isLoopbackIPv4 = host.startsWith("127.");
    if (isLoopbackHost || isLoopbackIPv4) {
      return true;
    }
    // 获取页面 URL
    const pageUrl = new URL(window.location.href);
    // 如果与页面同源，则信任
    return gatewayUrl.host === pageUrl.host;
  } catch {
    return false;
  }
}

// ============ Gateway Hello 类型 ============

/**
 * Gateway 连接成功后的 Hello 响应类型
 */
export type GatewayHelloOk = {
  // 消息类型
  type: "hello-ok";
  // 协议版本
  protocol: number;
  // 服务器信息（可选）
  server?: {
    version?: string;
    connId?: string;
  };
  // 支持的功能（可选）
  features?: { methods?: string[]; events?: string[] };
  // 状态快照（可选）
  snapshot?: unknown;
  // 认证信息
  auth: {
    // 设备令牌（可选）
    deviceToken?: string;
    // 角色
    role: string;
    // 权限范围列表
    scopes: string[];
    // 发行时间戳（可选）
    issuedAtMs?: number;
  };
  // Canvas 主机 URL（可选）
  canvasHostUrl?: string;
  // 策略配置（可选）
  policy?: { tickIntervalMs?: number };
};

// ============ 内部类型 ============

/**
 * 待处理请求类型
 */
type Pending = {
  // 成功回调
  resolve: (value: unknown) => void;
  // 失败回调
  reject: (err: unknown) => void;
};

/**
 * 选定的连接认证类型
 */
type SelectedConnectAuth = {
  // 认证令牌（可选）
  authToken?: string;
  // 设备认证令牌（可选）
  authDeviceToken?: string;
  // 密码（可选）
  authPassword?: string;
  // 解析后的设备令牌（可选）
  resolvedDeviceToken?: string;
  // 存储的令牌（可选）
  storedToken?: string;
  // 是否可回退到共享令牌
  canFallbackToShared: boolean;
};

// ============ 常量定义 ============

/**
 * 控制面板操作员角色
 */
export const CONTROL_UI_OPERATOR_ROLE = "operator";

/**
 * 控制面板操作员权限范围列表
 */
export const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",     // 管理员权限
  "operator.read",      // 读取权限
  "operator.write",     // 写入权限
  "operator.approvals",  // 审批权限
  "operator.pairing",   // 配对权限
] as const;

// ============ 连接参数类型 ============

/**
 * Gateway 连接认证参数
 */
export type GatewayConnectAuth = {
  token?: string;
  deviceToken?: string;
  password?: string;
};

/**
 * Gateway 连接设备参数
 */
export type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

/**
 * Gateway 连接客户端信息
 */
export type GatewayConnectClientInfo = {
  id: GatewayClientName;
  version: string;
  platform: string;
  mode: GatewayClientMode;
  instanceId?: string;
};

/**
 * Gateway 连接参数
 */
export type GatewayConnectParams = {
  // 最低协议版本
  minProtocol: 3;
  // 最高协议版本
  maxProtocol: 3;
  // 客户端信息
  client: GatewayConnectClientInfo;
  // 角色
  role: string;
  // 权限范围列表
  scopes: string[];
  // 设备信息（可选）
  device?: GatewayConnectDevice;
  // 支持的能力列表
  caps: string[];
  // 认证信息（可选）
  auth?: GatewayConnectAuth;
  // 用户代理字符串
  userAgent: string;
  // 语言环境
  locale: string;
};

/**
 * 连接计划类型
 */
type ConnectPlan = {
  role: string;
  scopes: string[];
  client: GatewayConnectClientInfo;
  explicitGatewayToken?: string;
  selectedAuth: SelectedConnectAuth;
  auth?: GatewayConnectAuth;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  device?: GatewayConnectDevice;
};

/**
 * 设备令牌重试决策类型
 */
type DeviceTokenRetryDecision = {
  deviceTokenRetryBudgetUsed: boolean;
  authDeviceToken?: string;
  explicitGatewayToken?: string;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  storedToken?: string;
  canRetryWithDeviceTokenHint: boolean;
  url: string;
};

// ============ 客户端选项和监听器类型 ============

/**
 * Gateway 浏览器客户端选项
 */
export type GatewayBrowserClientOptions = {
  // Gateway WebSocket URL
  url: string;
  // 认证令牌（可选）
  token?: string;
  // 密码（可选）
  password?: string;
  // 客户端名称（可选）
  clientName?: GatewayClientName;
  // 客户端版本（可选）
  clientVersion?: string;
  // 平台（可选）
  platform?: string;
  // 客户端模式（可选）
  mode?: GatewayClientMode;
  // 实例 ID（可选）
  instanceId?: string;
  // 接收到 Hello 回调
  onHello?: (hello: GatewayHelloOk) => void;
  // 接收到事件回调
  onEvent?: (evt: GatewayEventFrame) => void;
  // 连接关闭回调
  onClose?: (info: { code: number; reason: string; error?: GatewayErrorInfo }) => void;
  // 消息间隙回调
  onGap?: (info: { expected: number; received: number }) => void;
};

/**
 * Gateway 事件监听器类型
 */
export type GatewayEventListener = (evt: GatewayEventFrame) => void;

// ============ 常量 ============

// 4008 是应用定义的关闭代码（浏览器拒绝 1008 "策略违规"）
const CONNECT_FAILED_CLOSE_CODE = 4008;

// ============ 辅助函数 ============

/**
 * 构建 Gateway 连接认证对象
 * @param selectedAuth - 选定的认证信息
 * @returns Gateway 连接认证对象或 undefined
 */
function buildGatewayConnectAuth(
  selectedAuth: SelectedConnectAuth,
): GatewayConnectAuth | undefined {
  const authToken = selectedAuth.authToken;
  // 如果没有令牌和密码，返回 undefined
  if (!(authToken || selectedAuth.authPassword)) {
    return undefined;
  }
  return {
    token: authToken,
    // 优先使用设备认证令牌，否则使用解析后的设备令牌
    deviceToken: selectedAuth.authDeviceToken ?? selectedAuth.resolvedDeviceToken,
    password: selectedAuth.authPassword,
  };
}

/**
 * 构建 Gateway 连接设备信息
 * @param params - 设备构建参数
 * @returns 设备连接信息或 undefined
 */
async function buildGatewayConnectDevice(params: {
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  client: GatewayConnectClientInfo;
  role: string;
  scopes: string[];
  authToken?: string;
  connectNonce: string | null;
}): Promise<GatewayConnectDevice | undefined> {
  const { deviceIdentity } = params;
  // 如果没有设备身份，返回 undefined
  if (!deviceIdentity) {
    return undefined;
  }
  const signedAtMs = Date.now();
  const nonce = params.connectNonce ?? "";
  // 构建设备认证载荷
  const payload = buildDeviceAuthPayload({
    deviceId: deviceIdentity.deviceId,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: params.authToken ?? null,
    nonce,
  });
  // 对载荷进行签名
  const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
  return {
    id: deviceIdentity.deviceId,
    publicKey: deviceIdentity.publicKey,
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}

/**
 * 判断是否应该使用设备令牌重试
 * @param params - 重试决策参数
 * @returns 是否应该重试
 */
export function shouldRetryWithDeviceToken(params: DeviceTokenRetryDecision): boolean {
  return (
    // 重试预算未用完
    !params.deviceTokenRetryBudgetUsed &&
    // 没有认证设备令牌
    !params.authDeviceToken &&
    // 有明确的 Gateway 令牌
    Boolean(params.explicitGatewayToken) &&
    // 有设备身份
    Boolean(params.deviceIdentity) &&
    // 有存储的令牌
    Boolean(params.storedToken) &&
    // 可以使用设备令牌提示重试
    params.canRetryWithDeviceTokenHint &&
    // 是可信的重试端点
    isTrustedRetryEndpoint(params.url)
  );
}

// ============ Gateway 浏览器客户端类 ============

/**
 * Gateway 浏览器客户端类
 * 负责管理与 Gateway 服务器的 WebSocket 连接
 */
export class GatewayBrowserClient {
  // WebSocket 实例
  private ws: WebSocket | null = null;
  // 待处理请求映射
  private pending = new Map<string, Pending>();
  // 连接是否已关闭
  private closed = false;
  // 最后接收的序列号
  private lastSeq: number | null = null;
  // 连接随机数
  private connectNonce: string | null = null;
  // 是否已发送连接请求
  private connectSent = false;
  // 连接超时定时器
  private connectTimer: number | null = null;
  // 连接代数（用于区分多次连接尝试）
  private connectGeneration = 0;
  // 重连等待时间（毫秒）
  private backoffMs = 800;
  // 待处理的连接错误
  private pendingConnectError: GatewayErrorInfo | undefined;
  // 待处理的设备令牌重试
  private pendingDeviceTokenRetry = false;
  // 设备令牌重试预算是否已用完
  private deviceTokenRetryBudgetUsed = false;
  // 事件监听器集合
  private eventListeners = new Set<GatewayEventListener>();

  /**
   * 构造函数
   * @param opts - 客户端选项
   */
  constructor(private opts: GatewayBrowserClientOptions) {}

  /**
   * 启动客户端，开始连接
   */
  start() {
    this.closed = false;
    this.connect();
  }

  /**
   * 停止客户端，关闭连接
   */
  stop() {
    this.closed = true;
    this.clearConnectTimer();
    this.ws?.close();
    this.ws = null;
    this.pendingConnectError = undefined;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    // 拒绝所有待处理请求
    this.flushPending(new Error("gateway client stopped"));
  }

  /**
   * 获取连接状态
   */
  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 建立 WebSocket 连接
   */
  private connect() {
    // 如果已关闭，不连接
    if (this.closed) {
      return;
    }
    // 创建新的 WebSocket
    const ws = new WebSocket(this.opts.url);
    const generation = ++this.connectGeneration;
    this.ws = ws;

    // WebSocket 打开事件处理
    ws.addEventListener("open", () => this.queueConnect(ws, generation));
    
    // WebSocket 消息事件处理
    ws.addEventListener("message", (ev) => {
      // 检查 WebSocket 是否仍然活跃
      if (!this.isActiveSocket(ws, generation)) {
        return;
      }
      this.handleMessage(ws, generation, String(ev.data ?? ""));
    });

    // WebSocket 关闭事件处理
    ws.addEventListener("close", (ev) => {
      // 检查是否是我们的 WebSocket
      if (this.ws !== ws) {
        return;
      }
      const reason = ev.reason ?? "";
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      // 拒绝所有待处理请求
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      // 调用关闭回调
      this.opts.onClose?.({ code: ev.code, reason, error: connectError });
      // 获取错误代码
      const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
      // 如果是令牌不匹配且重试预算已用完，不重连
      if (
        connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH &&
        this.deviceTokenRetryBudgetUsed &&
        !this.pendingDeviceTokenRetry
      ) {
        return;
      }
      // 如果不是不可恢复的认证错误，安排重连
      if (!isNonRecoverableAuthError(connectError)) {
        this.scheduleReconnect();
      }
    });

    // WebSocket 错误事件处理（忽略，close 事件会处理）
    ws.addEventListener("error", () => {
      // ignored; close handler will fire
    });
  }

  /**
   * 安排重连
   */
  private scheduleReconnect() {
    // 如果已关闭，不重连
    if (this.closed) {
      return;
    }
    const delay = this.backoffMs;
    // 指数退避，最大 15 秒
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * 拒绝所有待处理请求
   * @param err - 错误对象
   */
  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  /**
   * 构建连接客户端信息
   * @returns 客户端信息对象
   */
  private buildConnectClient(): GatewayConnectClientInfo {
    return {
      id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: this.opts.clientVersion ?? "control-ui",
      platform: this.opts.platform ?? navigator.platform ?? "web",
      mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
      instanceId: this.opts.instanceId,
    };
  }

  /**
   * 构建连接参数
   * @param plan - 连接计划
   * @returns 连接参数
   */
  private buildConnectParams(plan: ConnectPlan): GatewayConnectParams {
    return {
      minProtocol: 3,
      maxProtocol: 3,
      client: plan.client,
      role: plan.role,
      scopes: plan.scopes,
      device: plan.device,
      caps: ["tool-events"],
      auth: plan.auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };
  }

  /**
   * 构建连接计划
   * @param connectNonce - 连接随机数
   * @returns 连接计划
   */
  private async buildConnectPlan(connectNonce: string | null): Promise<ConnectPlan> {
    const role = CONTROL_UI_OPERATOR_ROLE;
    const scopes = [...CONTROL_UI_OPERATOR_SCOPES];
    const client = this.buildConnectClient();
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;

    // crypto.subtle 仅在安全上下文中可用（HTTPS, localhost）。
    // 在纯 HTTP 下，跳过设备身份，回退到仅令牌认证。
    // 网关可能拒绝此请求，除非启用了 gateway.controlUi.allowInsecureAuth。
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let selectedAuth: SelectedConnectAuth = {
      authToken: explicitGatewayToken,
      authPassword: explicitPassword,
      canFallbackToShared: false,
    };

    // 在安全上下文中加载或创建设备身份
    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      selectedAuth = this.selectConnectAuth({
        role,
        deviceId: deviceIdentity.deviceId,
      });
    }

    return {
      role,
      scopes,
      client,
      explicitGatewayToken,
      selectedAuth,
      auth: buildGatewayConnectAuth(selectedAuth),
      deviceIdentity,
      device: await buildGatewayConnectDevice({
        deviceIdentity,
        client,
        role,
        scopes,
        authToken: selectedAuth.authToken,
        connectNonce,
      }),
    };
  }

  /**
   * 处理连接 Hello 响应
   */
  private handleConnectHello(
    hello: GatewayHelloOk,
    plan: ConnectPlan,
    ws: WebSocket,
    generation: number,
  ) {
    // 检查 WebSocket 是否仍然活跃
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    // 如果有设备令牌，存储它
    if (hello?.auth?.deviceToken && plan.deviceIdentity) {
      storeDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        role: hello.auth.role ?? plan.role,
        token: hello.auth.deviceToken,
        scopes: hello.auth.scopes ?? [],
      });
    }
    // 重置退避时间
    this.backoffMs = 800;
    // 调用 Hello 回调
    this.opts.onHello?.(hello);
  }

  /**
   * 处理连接失败
   */
  private handleConnectFailure(err: unknown, plan: ConnectPlan, ws: WebSocket, generation: number) {
    // 检查 WebSocket 是否仍然活跃
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    // 解析错误代码
    const connectErrorCode =
      err instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(err) : null;
    // 获取恢复建议
    const recoveryAdvice =
      err instanceof GatewayRequestError ? readConnectErrorRecoveryAdvice(err.details) : {};
    // 判断是否建议使用设备令牌重试
    const retryWithDeviceTokenRecommended =
      recoveryAdvice.recommendedNextStep === "retry_with_device_token";
    const canRetryWithDeviceTokenHint =
      recoveryAdvice.canRetryWithDeviceToken === true ||
      retryWithDeviceTokenRecommended ||
      connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;

    // 检查是否应该使用设备令牌重试
    if (
      shouldRetryWithDeviceToken({
        deviceTokenRetryBudgetUsed: this.deviceTokenRetryBudgetUsed,
        authDeviceToken: plan.selectedAuth.authDeviceToken,
        explicitGatewayToken: plan.explicitGatewayToken,
        deviceIdentity: plan.deviceIdentity,
        storedToken: plan.selectedAuth.storedToken,
        canRetryWithDeviceTokenHint,
        url: this.opts.url,
      })
    ) {
      this.pendingDeviceTokenRetry = true;
      this.deviceTokenRetryBudgetUsed = true;
    }

    // 存储连接错误信息
    if (err instanceof GatewayRequestError) {
      this.pendingConnectError = {
        code: err.gatewayCode,
        message: err.message,
        details: err.details,
        retryable: err.retryable,
        retryAfterMs: err.retryAfterMs,
      };
    } else {
      this.pendingConnectError = undefined;
    }

    // 检查是否使用了存储的设备令牌
    const usedStoredDeviceToken =
      Boolean(plan.selectedAuth.storedToken) &&
      (plan.selectedAuth.resolvedDeviceToken === plan.selectedAuth.storedToken ||
        plan.selectedAuth.authDeviceToken === plan.selectedAuth.storedToken);
    // 如果使用了存储令牌且出现设备令牌不匹配，清除存储的令牌
    if (
      usedStoredDeviceToken &&
      plan.deviceIdentity &&
      connectErrorCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
    ) {
      clearDeviceAuthToken({ deviceId: plan.deviceIdentity.deviceId, role: plan.role });
    }
    // 关闭 WebSocket
    ws.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
  }

  /**
   * 检查 WebSocket 是否仍然活跃
   */
  private isActiveSocket(ws: WebSocket, generation: number): boolean {
    return !this.closed && this.ws === ws && this.connectGeneration === generation;
  }

  /**
   * 发送连接请求
   */
  private async sendConnect(ws: WebSocket, generation: number) {
    // 检查 WebSocket 是否活跃且已打开
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    // 避免重复发送
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    this.clearConnectTimer();

    // 构建连接计划
    const plan = await this.buildConnectPlan(this.connectNonce);
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    // 如果有待处理的设备令牌重试，清除标志
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    // 发送连接请求
    void this.requestOnSocket<GatewayHelloOk>(ws, "connect", this.buildConnectParams(plan))
      .then((hello) => this.handleConnectHello(hello, plan, ws, generation))
      .catch((err: unknown) => this.handleConnectFailure(err, plan, ws, generation));
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(ws: WebSocket, generation: number, raw: string) {
    let parsed: unknown;
    // 尝试解析 JSON
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };
    // 处理事件帧
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      // 处理连接挑战事件
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect(ws, generation);
        }
        return;
      }
      // 处理序列号
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        // 检测消息间隙
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      // 调用事件处理器
      try {
        this.opts.onEvent?.(evt);
        for (const listener of this.eventListeners) {
          listener(evt);
        }
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    // 处理响应帧
    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }
      this.pending.delete(res.id);
      if (res.ok) {
        // 请求成功
        pending.resolve(res.payload);
      } else {
        // 请求失败，拒绝 Promise
        pending.reject(
          new GatewayRequestError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
            retryable: res.error?.retryable,
            retryAfterMs: res.error?.retryAfterMs,
          }),
        );
      }
      return;
    }
  }

  /**
   * 选择连接认证方式
   */
  private selectConnectAuth(params: { role: string; deviceId: string }): SelectedConnectAuth {
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const authPassword = this.opts.password?.trim() || undefined;
    // 加载存储的设备认证令牌
    const storedEntry = loadDeviceAuthToken({
      deviceId: params.deviceId,
      role: params.role,
    });
    const storedScopes = storedEntry?.scopes ?? [];
    // 检查存储的令牌是否有读取权限
    const storedTokenCanRead =
      params.role !== CONTROL_UI_OPERATOR_ROLE ||
      storedScopes.includes("operator.read") ||
      storedScopes.includes("operator.write") ||
      storedScopes.includes("operator.admin");
    const storedToken = storedTokenCanRead ? storedEntry?.token : undefined;
    // 判断是否应该使用设备重试令牌
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry &&
      Boolean(explicitGatewayToken) &&
      Boolean(storedToken) &&
      isTrustedRetryEndpoint(this.opts.url);
    // 解析设备令牌
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

  /**
   * 发送请求到 Gateway
   * @param method - 方法名
   * @param params - 参数
   * @returns Promise 结果
   */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    // 检查连接状态
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    return this.requestOnSocket(this.ws, method, params);
  }

  /**
   * 通过 WebSocket 发送请求
   */
  private requestOnSocket<T = unknown>(
    ws: WebSocket,
    method: string,
    params?: unknown,
  ): Promise<T> {
    // 检查 WebSocket 状态
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = generateUUID();
    const frame = { type: "req", id, method, params };
    // 创建 Promise 并存储待处理请求
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    // 发送消息
    ws.send(JSON.stringify(frame));
    return p;
  }

  /**
   * 添加事件监听器
   * @param listener - 事件监听器函数
   * @returns 取消监听器函数
   */
  addEventListener(listener: GatewayEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * 将连接放入队列
   */
  private queueConnect(ws: WebSocket, generation: number) {
    // 检查 WebSocket 是否仍然活跃
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectTimer();
    // 延迟发送连接请求
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      void this.sendConnect(ws, generation);
    }, 750);
  }

  /**
   * 清除连接定时器
   */
  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}
