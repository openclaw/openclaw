# OpenClaw 安全审计报告

**审计日期**: 2026-04-04
**项目**: OpenClaw — 多渠道 AI 网关，支持可扩展消息集成
**项目类型**: 服务端应用（网关 + 频道扩展）
**仓库**: https://github.com/openclaw/openclaw
**版本**: 2026.3.14
**审计范围**: 命令注入、路径遍历、SSRF、认证与 WebSocket 安全、插件系统

---

## 一、漏洞总览

| # | 严重级别 | 漏洞标题 | 所需权限 | 影响 |
|---|----------|----------|----------|------|
| 1 | **高危** | `workspaceOnly` 默认为 `false`，代理可无限制访问文件系统 | 频道认证用户 + LLM 提示注入 | 读写宿主机任意文件 |
| 2 | **中危** | 客户端自声明作用域，无设备身份绑定即可提权 | 网关共享令牌 | 获得管理员权限 |
| 3 | **中危** | 本地静默自动配对允许作用域升级 | 本地进程访问 | 本地恶意软件可获取网关管理员权限 |
| 4 | **中危** | 插件无运行时沙箱，加载后拥有完整进程权限 | 插件安装权限 | 完全控制宿主机 |
| 5 | **中危** | 插件可提取任意提供商的 API 密钥 | 插件安装权限 | 窃取 OpenAI/Anthropic 等 API 密钥 |
| 6 | **中危** | 多个扩展使用原始 `fetch()` 绕过 SSRF 防护 | 配置文件写入权限（运维级） | 内网探测、云元数据泄露 |
| 7 | **低中危** | 浏览器交互工具中使用 `eval()` | 浏览器 HTTP 认证 | 在浏览器页面上下文中执行 JS |
| 8 | **低中危** | 可信代理认证依赖 IP 级信任 | 网络位置欺骗 | 用户身份伪造 |
| 9 | **低危** | `auth.mode = "none"` 配合 LAN 绑定等于无认证 | 配置错误 | 未认证网关访问 |
| 10 | **低危** | 限速仅存内存，回环地址豁免 | 网关重启 | 暴力破解窗口重置 |
| 11 | **低危** | `config.openFile` 使用 `exec()` 而非 `execFile()` | 网关认证（内部路径） | 代码异味，不可利用 |

---

## 二、高危漏洞详情

### [高危] #1：代理文件系统工具默认无限制访问

**文件位置**:
- `src/agents/pi-tools.read.ts:721-732`
- `src/agents/tool-fs-policy.ts:8-12`
- `src/agents/apply-patch.ts:242-246`

**漏洞类型**: 路径遍历 / 权限提升

**攻击前提**:
- 已通过任何频道（Discord/Matrix/Slack/Telegram/WebSocket）认证
- 能通过提示注入影响 LLM 代理的工具调用

**调用链分析**:
1. 外部用户通过频道发送消息
2. LLM 代理处理消息，决定使用 `read`/`write`/`edit` 工具
3. `workspaceOnly` 默认为 `false` → 无路径边界检查
4. 代理读取 `/etc/shadow`、`~/.ssh/id_rsa`，或写入 `~/.ssh/authorized_keys`

**调用链状态**: ✅ 完整 — 频道认证 + LLM 提示注入是现实的攻击路径

**权限变化**: 外部频道用户 → 宿主机文件系统读写

**影响范围**: 所有使用该网关的用户，以及宿主机上的所有数据

**判定理由**: 攻击者仅需频道认证（通常是机器人 @ 提及即可触发 LLM）+ 精心构造的提示即可读写宿主机任意文件。`workspaceOnly` 默认为 `false` 意味着所有默认部署均受影响。

**漏洞链组合**: 配合 #2（作用域自声明），可通过网关获取更多权限后进一步利用文件系统访问。

**代码片段**:
```typescript
// pi-tools.read.ts:721-732
function createHostWriteOperations(root: string, options?: { workspaceOnly?: boolean }) {
  const workspaceOnly = options?.workspaceOnly ?? false;
  if (!workspaceOnly) {
    // workspaceOnly 为 false 时，允许在宿主机任意位置写入
    return {
      mkdir: async (dir: string) => {
        const resolved = path.resolve(dir);
        await fs.mkdir(resolved, { recursive: true });
      },
      writeFile: writeHostFile,  // ← 无边界检查
    } as const;
  }
  ...
}
```

**修复建议**:
- 将 `workspaceOnly` 默认值改为 `true`
- 对远程/网关会话强制启用工作区限制
- 在文档中明确说明 `workspaceOnly: false` 的安全风险

---

## 三、中危漏洞详情

### [中危] #2：客户端自声明作用域，无设备身份绑定

**文件位置**: `src/gateway/server/ws-connection/message-handler.ts:400-514`

**漏洞类型**: 权限提升

**攻击前提**: 掌握网关共享令牌（token/password）

**调用链分析**:
1. 攻击者获取共享网关令牌
2. 通过 WebSocket 连接，声明 `role: "operator"`、`scopes: ["operator.admin"]`，无设备身份
3. `roleCanSkipDeviceIdentity` 返回 `true`（operator + 共享认证通过）
4. 作用域 **不被清除**（决策 = "allow"）
5. 获得包含 `operator.admin` 作用域的完整管理员权限

**调用链状态**: ✅ 完整

**权限变化**: 共享令牌持有者 → 管理员作用域（权限提升）

**影响范围**: 网关管理员

**判定理由**: 共享令牌本应提供基本访问权限，但客户端可自行声明管理员作用域而无需设备身份验证，构成权限提升。

**修复建议**:
- 从设备身份绑定或服务端策略推导作用域，绝不信任客户端自声明
- 对无设备身份的连接强制清除所有作用域

---

### [中危] #3：本地静默自动配对允许作用域升级

**文件位置**: `src/gateway/server/ws-connection/message-handler.ts:739-768`

**漏洞类型**: 权限提升

**攻击前提**: 宿主机上的本地进程访问权限

**调用链分析**:
1. 本地恶意软件生成 Ed25519 密钥对
2. 连接到 `127.0.0.1` 上的网关 WebSocket
3. 提交配对请求，声明 `scopes: ["operator.admin"]`
4. 网关静默自动批准（回环地址 + control-ui）
5. 获得完整管理员权限，无需运维人员确认
6. `reason: "scope-upgrade"` 路径允许已配对设备升级作用域

**调用链状态**: ✅ 完整 — 任何本地进程均可利用

**权限变化**: 本地进程 → 网关管理员

**影响范围**: 网关管理员及所有连接的服务

**判定理由**: 本地恶意软件是常见的威胁模型，静默批准使得本地提权成为可能。

**修复建议**:
- 作用域升级（`scope-upgrade`）必须要求运维人员明确确认，即使在本地
- 限制静默配对仅授予最小权限作用域

---

### [中危] #4：插件无运行时沙箱

**文件位置**: `src/plugins/loader.ts:762`、`src/plugins/runtime/types-core.ts`

**漏洞类型**: 沙箱逃逸 / 权限提升

**攻击前提**: 插件安装或修改能力

**调用链分析**:
1. 攻击者发布/安装恶意插件
2. 插件通过 Jiti 加载到同一 Node.js 进程
3. 插件自由访问 `fs`、`child_process`、`process`、网络
4. 可读取所有文件、执行命令、窃取数据

**调用链状态**: ✅ 完整

**权限变化**: 插件安装 → 完全控制宿主机

**影响范围**: 整个宿主机及其上所有服务

**判定理由**: 插件加载后拥有不受限的进程权限，这是一个架构级的安全边界缺失。

**修复建议**:
- 实现插件权限/能力模型（声明需要的能力：文件系统、网络、进程、配置读写、密钥访问）
- 或在文档中明确说明：加载的插件是完全可信代码，等同于直接在网关进程中执行

---

### [中危] #5：插件可提取任意提供商的 API 密钥

**文件位置**: `src/plugins/runtime/types-core.ts:92-102`

**漏洞类型**: 信息泄露

**攻击前提**: 插件安装权限（与 #4 相同）

**调用链分析**:
1. 恶意插件已加载
2. 调用 `modelAuth.getApiKeyForModel()` 或 `resolveApiKeyForProvider()`
3. 获取任何提供商（OpenAI、Anthropic、Google 等）的 API 密钥

**调用链状态**: ✅ 完整（#4 的子场景）

**权限变化**: 插件访问 → 提取高价值 API 密钥

**影响范围**: 所有已配置的 AI 提供商账户

**漏洞链组合**: 配合 #4，形成"安装插件 → 窃取密钥"的完整攻击链

**修复建议**:
- 限制 `modelAuth` 访问仅限授权的提供商插件
- 实现按插件的密钥隔离

---

### [中危] #6：多个扩展绕过 SSRF 防护使用原始 fetch()

**文件位置**:
- `extensions/mattermost/src/mattermost/probe.ts:27` — 原始 `fetch()`
- `extensions/nextcloud-talk/src/send.ts:104,187` — 原始 `fetch()`
- `extensions/thread-ownership/index.ts:92` — `forwarderUrl` 原始 `fetch()`
- `src/tts/tts-core.ts:598,658,745` — TTS 提供商原始 `fetch()`
- `src/image-generation/providers/fal.ts:30-32` — 图像生成原始 `fetch()`
- `src/agents/models-config.providers.discovery.ts:50,106` — Ollama/vLLM 发现

**漏洞类型**: SSRF（服务端请求伪造）

**攻击前提**: 配置文件写入权限（运维级别）

**调用链分析**:
1. 运维人员在配置中设置 `baseUrl` 为 `http://169.254.169.254/...`
2. 服务端直接 `fetch()` 该 URL，无 DNS 钉扎、无私有 IP 检查
3. 可探测内网服务或访问云元数据

**调用链状态**: ⚠️ 需要配置级访问 — 外部用户无法直接利用

**权限变化**: 配置写入 → 内网探测

**影响范围**: 内部网络服务、云元数据服务

**判定理由**: 需要运维级配置权限才能利用，降低了风险。但 Matrix 扩展已正确实现了 SSRF 防护，其他扩展应保持一致。

**修复建议**:
- 所有扩展 HTTP 调用统一走 `src/infra/net/fetch-guard.ts` 中的 `fetchWithSsrFGuard`
- Matrix 扩展的 SSRF 传输层实现（`extensions/matrix/src/matrix/sdk/transport.ts`）可作为参考模板

---

## 四、低中危漏洞详情

### [低中危] #7：浏览器交互工具中的 eval()

**文件位置**: `src/browser/pw-tools-core.interactions.ts:354-408`

**漏洞类型**: 代码注入（浏览器上下文）

**调用链**: 代理工具调用 → Playwright `evaluate()` → 浏览器页面中的 `eval()`

**判定**: 这是浏览器自动化工具的设计行为，在浏览器沙箱中执行，不影响服务器进程。确保 `browser.evaluateEnabled` 默认为 `false` 即可。

---

### [低中危] #8：可信代理认证依赖 IP 级信任

**文件位置**: `src/gateway/auth.ts:326-363`

**漏洞类型**: 认证绕过

**判定**: `auth.mode = "trusted-proxy"` 仅通过源 IP 验证代理身份。若攻击者能从可信 IP 发送流量或绕过代理直连网关，可伪造用户头信息冒充任意用户。

---

## 五、低危漏洞详情

### [低危] #9：auth.mode = "none" 配合 LAN 绑定

**文件位置**: `src/gateway/auth.ts:402-403`

当 `auth.mode` 为 `"none"` 且网关绑定到 `0.0.0.0` 时，任何 LAN 客户端可无认证连接。网关启动时会警告但不会拒绝启动。

### [低危] #10：限速仅存内存

**文件位置**: `src/gateway/auth-rate-limit.ts:99`

限速状态存储在 `Map` 中，网关重启后清空，攻击者可在重启后重试暴力破解。回环地址豁免限速。

### [低危] #11：config.openFile 使用 exec()

**文件位置**: `src/gateway/server-methods/config.ts:536-550`

使用 `child_process.exec()` 而非更安全的 `execFile()`，但命令参数来自内部配置路径，非用户可控。属于代码异味。

---

## 六、正面安全控制（已确认有效）

| 控制措施 | 位置 | 质量 |
|----------|------|------|
| 时序安全密钥比较 | `src/security/secret-equal.ts` | ✅ SHA-256 + `timingSafeEqual` |
| SSRF DNS 钉扎 + IPv6 规范化 | `src/infra/net/ssrf.ts` | ✅ 全面覆盖 |
| 边界文件读取（拒绝符号链接/硬链接） | `src/infra/boundary-file-read.ts` | ✅ 优秀 |
| 原型链污染防护 | `src/infra/prototype-keys.ts`、`src/config/merge-patch.ts` | ✅ 集中阻止列表 + 测试覆盖 |
| 配置 include 路径遍历防护 | `src/config/includes.ts` | ✅ 符号链接 + 深度 + 循环引用 |
| 归档 zip-slip 防护 | `src/infra/archive-path.ts` | ✅ 路径规范化 + 根目录限制 |
| 媒体服务输入验证 | `src/media/server.ts` | ✅ 严格 ID 模式 + 根目录限制 |
| BlueBubbles 媒体路径验证 | `extensions/bluebubbles/src/media-send.ts` | ✅ O_NOFOLLOW + 双重 realpath + inode 校验 |
| 网关认证启动守护 | `src/gateway/server-runtime-config.ts` | ✅ 非回环绑定时拒绝无认证启动 |
| Matrix SSRF 传输层 | `extensions/matrix/src/matrix/sdk/transport.ts` | ✅ 每次重定向都做 SSRF 校验 |
| 设备签名 nonce + 时间戳验证 | 网关消息处理器 | ✅ 服务端生成 nonce，2 分钟窗口 |
| 密钥文件权限 | `src/plugin-sdk/json-store.ts` | ✅ 0o600 权限 |

---

## 七、修复优先级建议

| 优先级 | 建议 | 工作量 | 影响 |
|--------|------|--------|------|
| **P0** | 将远程会话的 `workspaceOnly` 默认改为 `true` | 低 | 消除最高危漏洞 |
| **P1** | 服务端推导作用域，清除无设备身份连接的自声明作用域 | 中 | 防止权限提升 |
| **P1** | 作用域升级要求运维确认，即使来自本地 | 低 | 防止本地提权 |
| **P2** | 所有扩展 HTTP 调用统一使用 `fetchWithSsrFGuard` | 中 | 统一 SSRF 防护 |
| **P2** | 实现插件权限/能力模型 | 高 | 缩小插件攻击面 |
| **P3** | 限制 `modelAuth` API 访问仅限授权插件 | 中 | 防止密钥泄露 |
| **P3** | 限速状态持久化或使用 Redis | 中 | 防止重启后暴力破解 |

---

## 八、审计方法

本次审计使用 5 个并行审计代理，分别覆盖：

1. **命令注入审计** — 搜索 `exec`、`spawn`、`eval`、`Function()` 等危险函数调用
2. **路径遍历审计** — 搜索文件读写操作、路径拼接、符号链接处理
3. **SSRF 审计** — 分析网络请求、DNS 解析、重定向处理、SSRF 防护绕过
4. **认证与 WebSocket 审计** — 分析网关认证流程、设备配对、作用域验证、限速
5. **插件系统审计** — 分析插件加载、SDK 暴露面、原型链污染、配置隔离

每个发现均经过完整调用链分析，确认触发路径、前置条件和实际可利用性。
