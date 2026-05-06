import { i18n } from "../../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { ConfigUiHint, ConfigUiHints } from "../types.ts";

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  tags?: string[];
  "x-tags"?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  nullable?: boolean;
};

export function schemaType(schema: JsonSchema): string | undefined {
  if (!schema) {
    return undefined;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.find((t) => t !== "null") ?? schema.type[0];
  }
  return schema.type;
}

export function defaultValue(schema?: JsonSchema): unknown {
  if (!schema) {
    return "";
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  const type = schemaType(schema);
  switch (type) {
    case "object":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "string":
      return "";
    default:
      return "";
  }
}

export function pathKey(path: Array<string | number>): string {
  return path.filter((segment) => typeof segment === "string").join(".");
}

export function hintForPath(path: Array<string | number>, hints: ConfigUiHints) {
  const key = pathKey(path);
  const direct = hints[key];
  if (direct) {
    return direct;
  }
  const segments = path.map(String);
  for (const [hintKey, hint] of Object.entries(hints)) {
    if (!hintKey.includes("*")) {
      continue;
    }
    const hintSegments = hintKey.split(".");
    if (hintSegments.length !== segments.length) {
      continue;
    }
    let match = true;
    for (let i = 0; i < segments.length; i += 1) {
      if (hintSegments[i] !== "*" && hintSegments[i] !== segments[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return hint;
    }
  }
  return undefined;
}

export function humanize(raw: string) {
  return raw
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/^./, (m) => m.toUpperCase());
}

const CONFIG_EXACT_TRANSLATIONS: Record<string, string> = {
  "Setup Wizard State": "Trạng thái trình hướng dẫn thiết lập",
  Config: "Cấu hình",
  Communication: "Liên lạc",
  Communications: "Liên lạc",
  Appearance: "Giao diện",
  Automation: "Tự động hóa",
  Infrastructure: "Hạ tầng",
  "AI & Agents": "AI & Agent",
  Updates: "Cập nhật",
  CLI: "CLI",
  Diagnostics: "Chẩn đoán",
  Logging: "Nhật ký",
  Gateway: "Gateway",
  "Node Host": "Node host",
  Agents: "Agent",
  Tools: "Công cụ",
  Binding: "Liên kết",
  Bindings: "Liên kết",
  Audio: "Âm thanh",
  Models: "Mô hình",
  Messages: "Tin nhắn",
  Commands: "Lệnh",
  Session: "Phiên",
  Cron: "Tác vụ Cron",
  Hooks: "Hook",
  UI: "UI",
  Browser: "Trình duyệt",
  Talk: "Giọng nói",
  Channels: "Kênh",
  Skills: "Kỹ năng",
  Plugins: "Tiện ích",
  Discovery: "Khám phá",
  Presence: "Hiện diện",
  "Voice Wake": "Đánh thức bằng giọng nói",
  Metadata: "Metadata",
  Environment: "Môi trường",
  "Environment Variables": "Biến môi trường",
  Authentication: "Xác thực",
  Broadcast: "Broadcast",
  "Canvas Host": "Canvas host",
  Secrets: "Secret",
  "Setup Wizard": "Trình hướng dẫn thiết lập",
  Web: "Web",
  Approvals: "Phê duyệt",
  Approval: "Phê duyệt",
  "Exec Approval Forwarding": "Chuyển tiếp phê duyệt exec",
  "Forward Exec Approvals": "Chuyển tiếp phê duyệt exec",
  "Approval Forwarding Mode": "Chế độ chuyển tiếp phê duyệt",
  "Approval Agent Filter": "Bộ lọc agent phê duyệt",
  "Approval Session Filter": "Bộ lọc phiên phê duyệt",
  "Approval Forwarding Targets": "Đích chuyển tiếp phê duyệt",
  "Approval Target Channel": "Kênh đích phê duyệt",
  "Approval Target Destination": "Đích nhận phê duyệt",
  "Approval Target Account ID": "ID tài khoản đích phê duyệt",
  "Approval Target Thread ID": "ID luồng đích phê duyệt",
  "Plugin Approval Forwarding": "Chuyển tiếp phê duyệt plugin",
  "Forward Plugin Approvals": "Chuyển tiếp phê duyệt plugin",
  "Plugin Approval Forwarding Mode": "Chế độ chuyển tiếp phê duyệt plugin",
  "Plugin Approval Agent Filter": "Bộ lọc agent phê duyệt plugin",
  "Plugin Approval Session Filter": "Bộ lọc phiên phê duyệt plugin",
  "Plugin Approval Forwarding Targets": "Đích chuyển tiếp phê duyệt plugin",
  "Plugin Approval Target Channel": "Kênh đích phê duyệt plugin",
  "Plugin Approval Target Destination": "Đích nhận phê duyệt plugin",
  "Plugin Approval Target Account ID": "ID tài khoản đích phê duyệt plugin",
  "Plugin Approval Target Thread ID": "ID luồng đích phê duyệt plugin",
  "Forwarding Mode": "Chế độ chuyển tiếp",
  "Agent Filter": "Bộ lọc agent",
  "Session Filter": "Bộ lọc phiên",
  "Forwarding Targets": "Đích chuyển tiếp",
  "Target Channel": "Kênh đích",
  "Target Destination": "Đích nhận",
  "Target Account ID": "ID tài khoản đích",
  "Target Thread ID": "ID luồng đích",
  ACP: "ACP",
  MCP: "MCP",
  Advanced: "Nâng cao",
  advanced: "nâng cao",
  Enabled: "Đã bật",
  Disabled: "Đã tắt",
  Default: "Mặc định",
  "Raw mode": "chế độ thô",
  "Structured value (SecretRef) - use Raw mode to edit":
    "Giá trị có cấu trúc (SecretRef) - dùng chế độ thô để chỉnh sửa",
  "Structured value (SecretRef) - edit the config file directly":
    "Giá trị có cấu trúc (SecretRef) - chỉnh trực tiếp tệp cấu hình",
  "Hide value": "Ẩn giá trị",
  "Reveal value": "Hiện giá trị",
  "Disable stream mode to reveal value": "Tắt chế độ stream để hiện giá trị",
  "JSON value": "Giá trị JSON",
  Add: "Thêm",
  "Add Entry": "Thêm mục",
  "No settings in this section": "Không có cài đặt trong mục này",
  "Environment variables passed to the gateway process":
    "Biến môi trường được truyền vào tiến trình Gateway",
  "Auto-update settings and release channel": "Cài đặt tự động cập nhật và kênh phát hành",
  "Agent configurations, models, and identities": "Cấu hình agent, mô hình và danh tính",
  "API keys and authentication profiles": "API key và hồ sơ xác thực",
  "Messaging channels (Telegram, Discord, Slack, etc.)":
    "Kênh nhắn tin (Telegram, Discord, Slack, v.v.)",
  "Message handling and routing settings": "Cài đặt xử lý và định tuyến tin nhắn",
  "Custom slash commands": "Lệnh slash tùy chỉnh",
  "Webhooks and event hooks": "Webhook và event hook",
  "Skill packs and capabilities": "Gói kỹ năng và năng lực",
  "Tool configurations (browser, search, etc.)": "Cấu hình công cụ (trình duyệt, tìm kiếm, v.v.)",
  "Gateway server settings (port, auth, binding)": "Cài đặt server Gateway (cổng, xác thực, bind)",
  "Setup wizard state and history": "Trạng thái và lịch sử trình hướng dẫn thiết lập",
  "Gateway metadata and version information": "Metadata Gateway và thông tin phiên bản",
  "Log levels and output configuration": "Mức log và cấu hình đầu ra",
  "Browser automation settings": "Cài đặt tự động hóa trình duyệt",
  "User interface preferences": "Tùy chọn giao diện người dùng",
  "AI model configurations and providers": "Cấu hình mô hình AI và nhà cung cấp",
  "Key bindings and shortcuts": "Key binding và phím tắt",
  "Top-level binding rules for routing and persistent ACP conversation ownership. Use type=route for normal routing and type=acp for persistent ACP harness bindings.":
    "Quy tắc liên kết cấp cao nhất cho định tuyến và quyền sở hữu hội thoại ACP lâu dài. Dùng type=route cho định tuyến thông thường và type=acp cho liên kết harness ACP lâu dài.",
  "Approval routing and forwarding controls": "Kiểm soát định tuyến và chuyển tiếp phê duyệt",
  "Node host controls and exposed local capabilities":
    "Kiểm soát node host và các năng lực cục bộ được mở ra",
  "Memory indexing, recall, and persistence": "Lập chỉ mục, truy hồi và lưu trữ bộ nhớ",
  "Media generation and processing settings": "Cài đặt tạo và xử lý media",
  "Broadcast and notification settings": "Cài đặt broadcast và thông báo",
  "Audio input/output settings": "Cài đặt đầu vào/đầu ra âm thanh",
  "Session management and persistence": "Quản lý và lưu trạng thái phiên",
  "Scheduled tasks and automation": "Tác vụ đã lên lịch và tự động hóa",
  "Web server and API settings": "Cài đặt web server và API",
  "Service discovery and networking": "Khám phá dịch vụ và mạng",
  "Canvas rendering and display": "Render và hiển thị canvas",
  "Voice and speech settings": "Cài đặt giọng nói và speech",
  "Plugin management and extensions": "Quản lý plugin và extension",
  "Instrumentation, OpenTelemetry, and cache-trace settings":
    "Instrumentation, OpenTelemetry và cài đặt cache-trace",
  "CLI banner and startup behavior": "Banner CLI và hành vi khởi động",
  "Secret provider configuration": "Cấu hình nhà cung cấp secret",
  "Agent Communication Protocol runtime and streaming settings":
    "Cài đặt runtime và streaming Agent Communication Protocol",
  "Model Context Protocol server definitions": "Định nghĩa server Model Context Protocol",
  "Update-channel and startup-check behavior for keeping OpenClaw runtime versions current. Use conservative channels in production and more experimental channels only in controlled environments.":
    "Hành vi kênh cập nhật và kiểm tra khi khởi động để giữ phiên bản runtime OpenClaw luôn mới. Dùng kênh thận trọng trong production và chỉ dùng kênh thử nghiệm hơn trong môi trường kiểm soát.",
  "CLI presentation controls for local command output behavior such as banner and tagline style. Use this section to keep startup output aligned with operator preference without changing runtime behavior.":
    "Kiểm soát cách hiển thị đầu ra lệnh cục bộ như banner và kiểu tagline. Dùng mục này để giữ đầu ra khởi động đúng sở thích vận hành mà không đổi hành vi runtime.",
  "Diagnostics controls for targeted tracing, telemetry export, and cache inspection during debugging. Keep baseline diagnostics minimal in production and enable deeper signals only when investigating issues.":
    "Kiểm soát chẩn đoán cho trace có mục tiêu, xuất telemetry và kiểm tra cache khi debug. Giữ chẩn đoán nền tối thiểu trong production và chỉ bật tín hiệu sâu khi điều tra sự cố.",
  "Logging behavior controls for severity, output destinations, formatting, and sensitive-data redaction. Keep levels and redaction strict enough for production while preserving useful diagnostics.":
    "Kiểm soát ghi log cho mức độ, đích đầu ra, định dạng và che dữ liệu nhạy cảm. Giữ mức log và che dữ liệu đủ chặt cho production nhưng vẫn còn thông tin chẩn đoán hữu ích.",
  "Gateway runtime surface for bind mode, auth, control UI, remote transport, and operational safety controls. Keep conservative defaults unless you intentionally expose the gateway beyond trusted local interfaces.":
    "Bề mặt runtime Gateway cho chế độ bind, xác thực, Control UI, truyền tải từ xa và kiểm soát an toàn vận hành. Giữ mặc định thận trọng trừ khi chủ động mở Gateway vượt ngoài giao diện cục bộ tin cậy.",
  "Node host controls for features exposed from this gateway node to other nodes or clients. Keep defaults unless you intentionally proxy local capabilities across your node network.":
    "Kiểm soát node host cho các tính năng được mở từ node Gateway này tới node hoặc client khác. Giữ mặc định trừ khi chủ động proxy năng lực cục bộ qua mạng node.",
  "Agent runtime configuration root covering defaults and explicit agent entries used for routing and execution context. Keep this section explicit so model/tool behavior stays predictable across multi-agent workflows.":
    "Gốc cấu hình runtime agent, gồm mặc định và các mục agent rõ ràng dùng cho định tuyến và ngữ cảnh thực thi. Giữ mục này rõ ràng để hành vi mô hình/công cụ dễ dự đoán trong workflow nhiều agent.",
  "Global tool access policy and capability configuration across web, exec, media, messaging, and elevated surfaces. Use this section to constrain risky capabilities before broad rollout.":
    "Chính sách truy cập công cụ toàn cục và cấu hình năng lực cho web, exec, media, nhắn tin và các bề mặt nâng quyền. Dùng mục này để giới hạn năng lực rủi ro trước khi mở rộng.",
  "Global audio ingestion settings used before higher-level tools process speech or media content. Configure this when you need deterministic transcription behavior for voice notes and clips.":
    "Cài đặt nhận âm thanh toàn cục dùng trước khi công cụ cấp cao xử lý giọng nói hoặc nội dung media. Cấu hình khi cần hành vi phiên âm ổn định cho ghi chú thoại và clip.",
  "Model catalog root for provider definitions, merge/replace behavior, and optional Bedrock discovery integration. Keep provider definitions explicit and validated before relying on production failover paths.":
    "Gốc danh mục mô hình cho định nghĩa nhà cung cấp, hành vi gộp/thay thế và tích hợp khám phá Bedrock tùy chọn. Giữ định nghĩa nhà cung cấp rõ ràng và đã xác thực trước khi dựa vào failover production.",
  "Message formatting, acknowledgment, queueing, debounce, and status reaction behavior for inbound/outbound chat flows. Use this section when channel responsiveness or message UX needs adjustment.":
    "Hành vi định dạng tin nhắn, xác nhận, hàng đợi, debounce và reaction trạng thái cho luồng chat vào/ra. Dùng mục này khi cần chỉnh độ phản hồi kênh hoặc UX tin nhắn.",
  "Controls chat command surfaces, owner gating, and elevated command access behavior across providers. Keep defaults unless you need stricter operator controls or broader command availability.":
    "Kiểm soát bề mặt lệnh chat, chặn theo chủ sở hữu và quyền truy cập lệnh nâng cao giữa các nhà cung cấp. Giữ mặc định trừ khi cần kiểm soát vận hành chặt hơn hoặc mở rộng lệnh.",
  "Global session routing, reset, delivery policy, and maintenance controls for conversation history behavior. Keep defaults unless you need stricter isolation, retention, or delivery constraints.":
    "Kiểm soát định tuyến phiên, reset, chính sách gửi và bảo trì cho hành vi lịch sử hội thoại. Giữ mặc định trừ khi cần cô lập, lưu giữ hoặc ràng buộc gửi chặt hơn.",
  "Global scheduler settings for stored cron jobs, run concurrency, delivery fallback, and run-session retention. Keep defaults unless you are scaling job volume or integrating external webhook receivers.":
    "Cài đặt bộ lập lịch toàn cục cho tác vụ Cron đã lưu, số lượt chạy đồng thời, fallback gửi và lưu giữ phiên chạy. Giữ mặc định trừ khi mở rộng số lượng job hoặc tích hợp receiver webhook ngoài.",
  "Inbound webhook automation surface for mapping external events into wake or agent actions in OpenClaw. Keep this locked down with explicit token/session/agent controls before exposing it beyond trusted networks.":
    "Bề mặt tự động hóa webhook chiều vào để ánh xạ sự kiện bên ngoài thành hành động wake hoặc agent trong OpenClaw. Khóa chặt bằng kiểm soát token/phiên/agent rõ ràng trước khi mở ra ngoài mạng tin cậy.",
  "UI presentation settings for accenting and assistant identity shown in control surfaces. Use this for branding and readability customization without changing runtime behavior.":
    "Cài đặt hiển thị UI cho màu nhấn và danh tính assistant trên các bề mặt điều khiển. Dùng để tùy chỉnh thương hiệu và độ dễ đọc mà không đổi hành vi runtime.",
  "Browser runtime controls for local or remote CDP attachment, profile routing, and screenshot/snapshot behavior. Keep defaults unless your automation workflow requires custom browser transport settings.":
    "Kiểm soát runtime trình duyệt cho gắn CDP cục bộ/từ xa, định tuyến profile và hành vi screenshot/snapshot. Giữ mặc định trừ khi workflow tự động hóa cần cấu hình truyền tải trình duyệt riêng.",
  "Talk-mode voice synthesis settings for voice identity, model selection, output format, and interruption behavior. Use this section to tune human-facing voice UX while controlling latency and cost.":
    "Cài đặt tổng hợp giọng nói chế độ Talk cho danh tính giọng, chọn mô hình, định dạng đầu ra và hành vi ngắt lời. Dùng mục này để tinh chỉnh UX giọng nói cho người dùng đồng thời kiểm soát độ trễ và chi phí.",
  "Channel provider configurations plus shared defaults that control access policies, heartbeat visibility, and per-surface behavior. Keep defaults centralized and override per provider only where required.":
    "Cấu hình nhà cung cấp kênh cùng mặc định dùng chung kiểm soát chính sách truy cập, hiển thị heartbeat và hành vi theo từng bề mặt. Giữ mặc định tập trung và chỉ ghi đè theo nhà cung cấp khi cần.",
  "Plugin system controls for enabling extensions, constraining load scope, configuring entries, and tracking installs. Keep plugin policy explicit and least-privilege in production environments.":
    "Kiểm soát hệ thống plugin để bật plugin, giới hạn phạm vi tải, cấu hình mục và theo dõi cài đặt. Giữ chính sách plugin rõ ràng và tối thiểu quyền trong môi trường production.",
  "Service discovery settings for local mDNS advertisement and optional wide-area presence signaling. Keep discovery scoped to expected networks to avoid leaking service metadata.":
    "Cài đặt khám phá dịch vụ cho quảng bá mDNS cục bộ và tín hiệu hiện diện diện rộng tùy chọn. Giới hạn khám phá trong mạng dự kiến để tránh lộ metadata dịch vụ.",
  "Approval routing controls for forwarding exec and plugin approval requests to chat destinations outside the originating session. Keep these disabled unless operators need explicit out-of-band approval visibility.":
    "Kiểm soát định tuyến phê duyệt để chuyển tiếp yêu cầu phê duyệt exec và plugin tới đích chat bên ngoài phiên gốc. Giữ tắt trừ khi người vận hành cần thấy phê duyệt ngoài luồng rõ ràng.",
  "Groups exec-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Configure here when approval prompts must reach operational channels instead of only the origin thread.":
    "Nhóm hành vi chuyển tiếp phê duyệt exec, gồm bật/tắt, chế độ định tuyến, bộ lọc và đích rõ ràng. Cấu hình ở đây khi prompt phê duyệt phải tới kênh vận hành thay vì chỉ luồng gốc.",
  "Enables forwarding of exec approval requests to configured delivery destinations (default: false). Keep disabled in low-risk setups and enable only when human approval responders need channel-visible prompts.":
    "Bật chuyển tiếp yêu cầu phê duyệt exec tới các đích gửi đã cấu hình (mặc định: false). Giữ tắt trong thiết lập rủi ro thấp và chỉ bật khi người phê duyệt cần prompt hiển thị trên kênh.",
  'Controls where approval prompts are sent: "session" uses origin chat, "targets" uses configured targets, and "both" sends to both paths. Use "session" as baseline and expand only when operational workflow requires redundancy.':
    'Kiểm soát nơi gửi prompt phê duyệt: "session" dùng chat gốc, "targets" dùng các đích đã cấu hình, và "both" gửi theo cả hai đường. Dùng "session" làm nền và chỉ mở rộng khi workflow vận hành cần dự phòng.',
  'Optional allowlist of agent IDs eligible for forwarded approvals, for example `["primary", "ops-agent"]`. Use this to limit forwarding blast radius and avoid notifying channels for unrelated agents.':
    'Danh sách cho phép tùy chọn gồm ID agent đủ điều kiện nhận phê duyệt chuyển tiếp, ví dụ `["primary", "ops-agent"]`. Dùng để giới hạn phạm vi ảnh hưởng và tránh thông báo kênh cho agent không liên quan.',
  'Optional session-key filters matched as substring or regex-style patterns, for example `["discord:", "^agent:ops:"]`. Use narrow patterns so only intended approval contexts are forwarded to shared destinations.':
    'Bộ lọc session-key tùy chọn, khớp theo chuỗi con hoặc pattern kiểu regex, ví dụ `["discord:", "^agent:ops:"]`. Dùng pattern hẹp để chỉ chuyển tiếp đúng ngữ cảnh phê duyệt tới đích dùng chung.',
  "Explicit delivery targets used when forwarding mode includes targets, each with channel and destination details. Keep target lists least-privilege and validate each destination before enabling broad forwarding.":
    "Các đích gửi rõ ràng dùng khi chế độ chuyển tiếp bao gồm targets, mỗi mục có thông tin kênh và đích nhận. Giữ danh sách đích ở mức tối thiểu quyền và xác thực từng đích trước khi bật chuyển tiếp rộng.",
  "Channel/provider ID used for forwarded approval delivery, such as discord, slack, or a plugin channel id. Use valid channel IDs only so approvals do not silently fail due to unknown routes.":
    "ID kênh/nhà cung cấp dùng để gửi phê duyệt chuyển tiếp, ví dụ discord, slack hoặc ID kênh plugin. Chỉ dùng ID kênh hợp lệ để phê duyệt không lỗi âm thầm vì route không xác định.",
  "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider). Verify semantics per provider because destination format differs across channel integrations.":
    "Định danh đích bên trong kênh mục tiêu (ID kênh, ID người dùng hoặc gốc luồng tùy nhà cung cấp). Kiểm tra ngữ nghĩa theo từng nhà cung cấp vì định dạng đích khác nhau giữa các tích hợp kênh.",
  "Optional account selector for multi-account channel setups when approvals must route through a specific account context. Use this only when the target channel has multiple configured identities.":
    "Bộ chọn tài khoản tùy chọn cho thiết lập kênh nhiều tài khoản khi phê duyệt phải đi qua một ngữ cảnh tài khoản cụ thể. Chỉ dùng khi kênh đích có nhiều danh tính đã cấu hình.",
  "Optional thread/topic target for channels that support threaded delivery of forwarded approvals. Use this to keep approval traffic contained in operational threads instead of main channels.":
    "Đích luồng/chủ đề tùy chọn cho kênh hỗ trợ gửi phê duyệt chuyển tiếp theo luồng. Dùng để giữ lưu lượng phê duyệt trong luồng vận hành thay vì kênh chính.",
  "Groups plugin-approval forwarding behavior including enablement, routing mode, filters, and explicit targets. Independent of exec approval forwarding. Configure here when plugin approval prompts must reach operational channels.":
    "Nhóm hành vi chuyển tiếp phê duyệt plugin, gồm bật/tắt, chế độ định tuyến, bộ lọc và đích rõ ràng. Độc lập với chuyển tiếp phê duyệt exec. Cấu hình ở đây khi prompt phê duyệt plugin phải tới kênh vận hành.",
  "Enables forwarding of plugin approval requests to configured delivery destinations (default: false). Independent of approvals.exec.enabled.":
    "Bật chuyển tiếp yêu cầu phê duyệt plugin tới các đích gửi đã cấu hình (mặc định: false). Độc lập với approvals.exec.enabled.",
  'Controls where plugin approval prompts are sent: "session" uses origin chat, "targets" uses configured targets, and "both" sends to both paths.':
    'Kiểm soát nơi gửi prompt phê duyệt plugin: "session" dùng chat gốc, "targets" dùng các đích đã cấu hình, và "both" gửi theo cả hai đường.',
  'Optional allowlist of agent IDs eligible for forwarded plugin approvals, for example `["primary", "ops-agent"]`. Use this to limit forwarding blast radius.':
    'Danh sách cho phép tùy chọn gồm ID agent đủ điều kiện nhận phê duyệt plugin chuyển tiếp, ví dụ `["primary", "ops-agent"]`. Dùng để giới hạn phạm vi ảnh hưởng.',
  'Optional session-key filters matched as substring or regex-style patterns, for example `["discord:", "^agent:ops:"]`. Use narrow patterns so only intended approval contexts are forwarded.':
    'Bộ lọc session-key tùy chọn, khớp theo chuỗi con hoặc pattern kiểu regex, ví dụ `["discord:", "^agent:ops:"]`. Dùng pattern hẹp để chỉ chuyển tiếp đúng ngữ cảnh phê duyệt.',
  "Explicit delivery targets used when plugin approval forwarding mode includes targets, each with channel and destination details.":
    "Các đích gửi rõ ràng dùng khi chế độ chuyển tiếp phê duyệt plugin bao gồm targets, mỗi mục có thông tin kênh và đích nhận.",
  "Channel/provider ID used for forwarded plugin approval delivery, such as discord, slack, or a plugin channel id.":
    "ID kênh/nhà cung cấp dùng để gửi phê duyệt plugin chuyển tiếp, ví dụ discord, slack hoặc ID kênh plugin.",
  "Destination identifier inside the target channel (channel ID, user ID, or thread root depending on provider).":
    "Định danh đích bên trong kênh mục tiêu (ID kênh, ID người dùng hoặc gốc luồng tùy nhà cung cấp).",
  "Optional account selector for multi-account channel setups when plugin approvals must route through a specific account context.":
    "Bộ chọn tài khoản tùy chọn cho thiết lập kênh nhiều tài khoản khi phê duyệt plugin phải đi qua một ngữ cảnh tài khoản cụ thể.",
  "Optional thread/topic target for channels that support threaded delivery of forwarded plugin approvals.":
    "Đích luồng/chủ đề tùy chọn cho kênh hỗ trợ gửi phê duyệt plugin chuyển tiếp theo luồng.",
};

const CONFIG_PHRASE_TRANSLATIONS: Array<[RegExp, string]> = [
  [/\bAI & Agents\b/g, "AI & Agent"],
  [/\bCommunication\b/g, "Liên lạc"],
  [/\bCommunications\b/g, "Liên lạc"],
  [/\bAppearance\b/g, "Giao diện"],
  [/\bAutomation\b/g, "Tự động hóa"],
  [/\bInfrastructure\b/g, "Hạ tầng"],
  [/\bApproval Forwarding\b/g, "Chuyển tiếp phê duyệt"],
  [/\bApproval Target\b/g, "Đích phê duyệt"],
  [/\bApproval Agent\b/g, "Agent phê duyệt"],
  [/\bApproval Session\b/g, "Phiên phê duyệt"],
  [/\bApprovals\b/g, "Phê duyệt"],
  [/\bApproval\b/g, "Phê duyệt"],
  [/\bForwarding\b/g, "Chuyển tiếp"],
  [/\bTargets\b/g, "Đích"],
  [/\bTarget\b/g, "Đích"],
  [/\bDestination\b/g, "Đích nhận"],
  [/\bDestinations\b/g, "Đích nhận"],
  [/\bFilter\b/g, "Bộ lọc"],
  [/\bFilters\b/g, "Bộ lọc"],
  [/\bAllowlist\b/g, "Danh sách cho phép"],
  [/\bBinding\b/g, "Liên kết"],
  [/\bBindings\b/g, "Liên kết"],
  [/\bSetup Wizard State\b/g, "Trạng thái trình hướng dẫn thiết lập"],
  [/\bConfig Last Touched Version\b/g, "Phiên bản cấu hình chỉnh sửa gần nhất"],
  [/\bConfig Last Touched At\b/g, "Thời điểm cấu hình chỉnh sửa gần nhất"],
  [/\bShell Environment Import\b/g, "Nhập môi trường shell"],
  [/\bShell Environment\b/g, "Môi trường shell"],
  [/\bEnvironment Import\b/g, "Nhập môi trường"],
  [/\bNode Host\b/g, "Node host"],
  [/\bAgent Runtime Fallback\b/g, "Fallback runtime agent"],
  [/\bAgent Runtime Settings\b/g, "Cài đặt runtime agent"],
  [/\bAgent Runtime\b/g, "Runtime agent"],
  [/\bEmbedded Harness\b/g, "Harness nhúng"],
  [/\bLegacy Embedded Harness\b/g, "Harness nhúng cũ"],
  [/\bACP Working Directory\b/g, "Thư mục làm việc ACP"],
  [/\bWorking Directory\b/g, "Thư mục làm việc"],
  [/\bContext Limits\b/g, "Giới hạn ngữ cảnh"],
  [/\bContext Limit\b/g, "Giới hạn ngữ cảnh"],
  [/\bContext Tokens\b/g, "Token ngữ cảnh"],
  [/\bTool Result Max Chars\b/g, "Số ký tự tối đa của kết quả công cụ"],
  [/\bPost-compaction Max Chars\b/g, "Số ký tự tối đa sau nén"],
  [/\bSkills Prompt Max Chars\b/g, "Số ký tự tối đa của prompt kỹ năng"],
  [/\bmemory_get Max Chars\b/g, "Số ký tự tối đa memory_get"],
  [/\bmemory_get Line Window\b/g, "Cửa sổ dòng memory_get"],
  [/\bMemory Get Max Chars\b/g, "Số ký tự tối đa đọc bộ nhớ"],
  [/\bLine Window\b/g, "Cửa sổ dòng"],
  [/\bFast Mode Default\b/g, "Mặc định chế độ nhanh"],
  [/\bThinking Default\b/g, "Mặc định mức suy luận"],
  [/\bReasoning Default\b/g, "Mặc định hiển thị reasoning"],
  [/\bAgent Defaults\b/g, "Mặc định agent"],
  [/\bAgent List\b/g, "Danh sách agent"],
  [/\bModel Catalog\b/g, "Danh mục mô hình"],
  [/\bProvider Definitions\b/g, "Định nghĩa nhà cung cấp"],
  [/\bAPI Key\b/g, "API key"],
  [/\bToken File\b/g, "Tệp token"],
  [/\bToken\b/g, "Token"],
  [/\bSecret Ref\b/g, "Tham chiếu secret"],
  [/\bSecret\b/g, "Secret"],
  [/\bPassword\b/g, "Mật khẩu"],
  [/\bTimeout\b/g, "Timeout"],
  [/\bInterval\b/g, "Khoảng lặp"],
  [/\bRetries\b/g, "Số lần thử lại"],
  [/\bRetry\b/g, "Thử lại"],
  [/\bMax Chars\b/g, "Số ký tự tối đa"],
  [/\bMin Chars\b/g, "Số ký tự tối thiểu"],
  [/\bMax Tokens\b/g, "Token tối đa"],
  [/\bMax Items\b/g, "Số mục tối đa"],
  [/\bMax Age\b/g, "Tuổi tối đa"],
  [/\bDefault Model\b/g, "Mô hình mặc định"],
  [/\bModel\b/g, "Mô hình"],
  [/\bProvider\b/g, "Nhà cung cấp"],
  [/\bRuntime\b/g, "Runtime"],
  [/\bFallback\b/g, "Fallback"],
  [/\bMode\b/g, "Chế độ"],
  [/\bPolicy\b/g, "Chính sách"],
  [/\bProfile\b/g, "Hồ sơ"],
  [/\bWorkspace\b/g, "Workspace"],
  [/\bDirectory\b/g, "Thư mục"],
  [/\bPath\b/g, "Đường dẫn"],
  [/\bFile\b/g, "Tệp"],
  [/\bURL\b/g, "URL"],
  [/\bBase Url\b/g, "URL gốc"],
  [/\bBase URL\b/g, "URL gốc"],
  [/\bBind\b/g, "Bind"],
  [/\bPort\b/g, "Cổng"],
  [/\bHost\b/g, "Host"],
  [/\bAuth\b/g, "Xác thực"],
  [/\bAuthentication\b/g, "Xác thực"],
  [/\bControl UI\b/g, "Control UI"],
  [/\bDashboard\b/g, "Dashboard"],
  [/\bChannel\b/g, "Kênh"],
  [/\bChannels\b/g, "Kênh"],
  [/\bMedia\b/g, "Media"],
  [/\bMessage\b/g, "Tin nhắn"],
  [/\bMessages\b/g, "Tin nhắn"],
  [/\bCommand\b/g, "Lệnh"],
  [/\bCommands\b/g, "Lệnh"],
  [/\bSession\b/g, "Phiên"],
  [/\bSessions\b/g, "Phiên"],
  [/\bBrowser\b/g, "Trình duyệt"],
  [/\bAudio\b/g, "Âm thanh"],
  [/\bVoice\b/g, "Giọng nói"],
  [/\bSpeech\b/g, "Giọng nói"],
  [/\bPresence\b/g, "Hiện diện"],
  [/\bDiscovery\b/g, "Khám phá"],
  [/\bDiagnostics\b/g, "Chẩn đoán"],
  [/\bLogging\b/g, "Nhật ký"],
  [/\bUpdate\b/g, "Cập nhật"],
  [/\bUpdates\b/g, "Cập nhật"],
  [/\bMetadata\b/g, "Metadata"],
  [/\bEnvironment\b/g, "Môi trường"],
  [/\bEnabled\b/g, "Đã bật"],
  [/\bDisabled\b/g, "Đã tắt"],
  [/\bDefault\b/g, "Mặc định"],
  [/\bOptional\b/g, "Tùy chọn"],
  [/\bGlobal\b/g, "Toàn cục"],
  [/\bLocal\b/g, "Cục bộ"],
  [/\bRemote\b/g, "Từ xa"],
  [/\bPublic\b/g, "Công khai"],
  [/\bPrivate\b/g, "Riêng tư"],
  [/\bSafety\b/g, "An toàn"],
  [/\bSecurity\b/g, "Bảo mật"],
  [/\bRedaction\b/g, "Che dữ liệu nhạy cảm"],
  [/\bCache\b/g, "Cache"],
  [/\bTrace\b/g, "Trace"],
  [/\bTelemetry\b/g, "Telemetry"],
  [/\bPrompt\b/g, "Prompt"],
  [/\bMemory\b/g, "Bộ nhớ"],
  [/\bSkill\b/g, "Kỹ năng"],
  [/\bSkills\b/g, "Kỹ năng"],
  [/\bTool\b/g, "Công cụ"],
  [/\bTools\b/g, "Công cụ"],
  [/\bPlugin\b/g, "Plugin"],
  [/\bPlugins\b/g, "Plugin"],
  [/\bEntry\b/g, "Mục"],
  [/\bEntries\b/g, "Mục"],
  [/\bList\b/g, "Danh sách"],
  [/\bCount\b/g, "Số lượng"],
  [/\bLimit\b/g, "Giới hạn"],
  [/\bLimits\b/g, "Giới hạn"],
  [/\bSetting\b/g, "Cài đặt"],
  [/\bSettings\b/g, "Cài đặt"],
  [/\bState\b/g, "Trạng thái"],
  [/\bStatus\b/g, "Trạng thái"],
  [/\bType\b/g, "Kiểu"],
  [/\bName\b/g, "Tên"],
  [/\bLabel\b/g, "Nhãn"],
  [/\bDescription\b/g, "Mô tả"],
  [/\bTitle\b/g, "Tiêu đề"],
  [/\bValue\b/g, "Giá trị"],
  [/\bValues\b/g, "Giá trị"],
  [/\bKey\b/g, "Khóa"],
  [/\bKeys\b/g, "Khóa"],
  [/\bID\b/g, "ID"],
  [/\bId\b/g, "ID"],
];

const CONFIG_DESCRIPTION_TRANSLATIONS: Array<[RegExp, string]> = [
  [/\bGroups\b/g, "Nhóm"],
  [/\bgroups\b/g, "nhóm"],
  [/\bincluding\b/g, "gồm"],
  [/\benablement\b/g, "bật/tắt"],
  [/\brouting mode\b/g, "chế độ định tuyến"],
  [/\bfilters\b/g, "bộ lọc"],
  [/\bexplicit targets\b/g, "đích rõ ràng"],
  [/\bapproval prompts\b/g, "prompt phê duyệt"],
  [/\bapproval requests\b/g, "yêu cầu phê duyệt"],
  [/\boperational channels\b/g, "kênh vận hành"],
  [/\borigin thread\b/g, "luồng gốc"],
  [/\boriginating session\b/g, "phiên gốc"],
  [/\bout-of-band\b/g, "ngoài luồng"],
  [/\bvisibility\b/g, "khả năng quan sát"],
  [/\bforwarded approvals\b/g, "phê duyệt chuyển tiếp"],
  [/\bforwarded plugin approvals\b/g, "phê duyệt plugin chuyển tiếp"],
  [/\bforwarded approval\b/g, "phê duyệt chuyển tiếp"],
  [/\bforwarded\b/g, "được chuyển tiếp"],
  [/\bforwarding\b/g, "chuyển tiếp"],
  [/\bForwarding\b/g, "Chuyển tiếp"],
  [/\bconfigured delivery destinations\b/g, "các đích gửi đã cấu hình"],
  [/\bconfigured targets\b/g, "các đích đã cấu hình"],
  [/\bdelivery destinations\b/g, "đích gửi"],
  [/\bdelivery targets\b/g, "đích gửi"],
  [/\btargets\b/g, "đích"],
  [/\bdestinations\b/g, "đích"],
  [/\bDestination\b/g, "Đích"],
  [/\beligible\b/g, "đủ điều kiện"],
  [/\ballowlist\b/g, "danh sách cho phép"],
  [/\bblast radius\b/g, "phạm vi ảnh hưởng"],
  [/\bunrelated agents\b/g, "agent không liên quan"],
  [/\bnotifying\b/g, "thông báo"],
  [/\blow-risk setups\b/g, "thiết lập rủi ro thấp"],
  [/\bhuman approval responders\b/g, "người phê duyệt"],
  [/\bchannel-visible prompts\b/g, "prompt hiển thị trên kênh"],
  [/\bsession-key filters\b/g, "bộ lọc session-key"],
  [/\bsubstring\b/g, "chuỗi con"],
  [/\bregex-style patterns\b/g, "pattern kiểu regex"],
  [/\bnarrow patterns\b/g, "pattern hẹp"],
  [/\bshared destinations\b/g, "đích dùng chung"],
  [/\bchannel\/provider ID\b/g, "ID kênh/nhà cung cấp"],
  [/\bplugin channel id\b/g, "ID kênh plugin"],
  [/\bunknown routes\b/g, "route không xác định"],
  [/\baccount selector\b/g, "bộ chọn tài khoản"],
  [/\bmulti-account channel setups\b/g, "thiết lập kênh nhiều tài khoản"],
  [/\bspecific account context\b/g, "ngữ cảnh tài khoản cụ thể"],
  [/\bthread\/topic target\b/g, "đích luồng/chủ đề"],
  [/\bthreaded delivery\b/g, "gửi theo luồng"],
  [/\bAuto-set when OpenClaw writes the config\b/g, "Tự đặt khi OpenClaw ghi cấu hình"],
  [
    /\bISO timestamp of the last config write \(auto-set\)\b/g,
    "Timestamp ISO của lần ghi cấu hình gần nhất (tự đặt)",
  ],
  [/\bOptional\b/g, "Tùy chọn"],
  [
    /\bShared default settings inherited by agents unless overridden per entry in agents\.list\b/g,
    "Cài đặt mặc định dùng chung được agent kế thừa trừ khi ghi đè trong agents.list",
  ],
  [
    /\bUse defaults to enforce consistent baseline behavior and reduce duplicated per-agent configuration\b/g,
    "Dùng mặc định để giữ hành vi nền nhất quán và giảm cấu hình lặp theo từng agent",
  ],
  [/\bKeep defaults unless\b/g, "Giữ mặc định trừ khi"],
  [/\bKeep this section explicit so\b/g, "Giữ mục này rõ ràng để"],
  [/\bUse this section to\b/g, "Dùng mục này để"],
  [/\bUse this to\b/g, "Dùng để"],
  [/\bUse this\b/g, "Dùng mục này"],
  [/\bConfigure this when\b/g, "Cấu hình mục này khi"],
  [/\bConfigure here when\b/g, "Cấu hình ở đây khi"],
  [/\bControls where\b/g, "Kiểm soát nơi"],
  [/\bControls\b/g, "Kiểm soát"],
  [/\bEnables\b/g, "Bật"],
  [/\bEnable\b/g, "Bật"],
  [/\bfalls back to\b/g, "fallback về"],
  [/\boverrides\b/g, "ghi đè"],
  [/\binherits\b/g, "kế thừa"],
  [/\binherited\b/g, "được kế thừa"],
  [/\bwhen omitted\b/g, "khi bỏ trống"],
  [/\bwhen no\b/g, "khi không có"],
  [/\bbefore\b/g, "trước khi"],
  [/\bafter\b/g, "sau khi"],
  [/\bduring startup\b/g, "trong lúc khởi động"],
  [/\bat startup\b/g, "khi khởi động"],
  [/\bproduction\b/g, "production"],
  [/\bdebugging\b/g, "debug"],
  [/\btroubleshooting\b/g, "xử lý sự cố"],
  [/\benable\b/g, "bật"],
  [/\benables\b/g, "bật"],
  [/\bdisable\b/g, "tắt"],
  [/\bdisabled\b/g, "đã tắt"],
  [/\bcontrol\b/g, "kiểm soát"],
  [/\bcontrols\b/g, "kiểm soát"],
  [/\bconfigure\b/g, "cấu hình"],
  [/\bconfiguration\b/g, "cấu hình"],
  [/\bbehavior\b/g, "hành vi"],
  [/\bsettings\b/g, "cài đặt"],
  [/\bfields\b/g, "trường"],
  [/\broot\b/g, "gốc"],
  [/\bcurrent\b/g, "hiện tại"],
  [/\bexplicit\b/g, "rõ ràng"],
  [/\bexplicitly\b/g, "rõ ràng"],
  [/\boptional\b/g, "tùy chọn"],
  [/\bglobal\b/g, "toàn cục"],
  [/\blocal\b/g, "cục bộ"],
  [/\bremote\b/g, "từ xa"],
  [/\bdefault\b/g, "mặc định"],
  [/\bmessage\b/g, "tin nhắn"],
  [/\bmessages\b/g, "tin nhắn"],
  [/\bapproval\b/g, "phê duyệt"],
  [/\bapprovals\b/g, "phê duyệt"],
  [/\bexec\b/g, "exec"],
  [/\bchannel\b/g, "kênh"],
  [/\bchannels\b/g, "kênh"],
  [/\bagent\b/g, "agent"],
  [/\bagents\b/g, "agent"],
  [/\bmodel\b/g, "mô hình"],
  [/\bmodels\b/g, "mô hình"],
  [/\bprovider\b/g, "nhà cung cấp"],
  [/\bproviders\b/g, "nhà cung cấp"],
  [/\btool\b/g, "công cụ"],
  [/\btools\b/g, "công cụ"],
  [/\bplugin\b/g, "plugin"],
  [/\bplugins\b/g, "plugin"],
  [/\bruntime\b/g, "runtime"],
  [/\bsession\b/g, "phiên"],
  [/\bsessions\b/g, "phiên"],
  [/\bcontext\b/g, "ngữ cảnh"],
  [/\bprompt\b/g, "prompt"],
  [/\bmemory\b/g, "bộ nhớ"],
  [/\bhistory\b/g, "lịch sử"],
  [/\bdelivery\b/g, "gửi/nhận"],
  [/\brouting\b/g, "định tuyến"],
  [/\broute\b/g, "route"],
  [/\bworkspace\b/g, "workspace"],
  [/\bdirectory\b/g, "thư mục"],
  [/\bfile\b/g, "tệp"],
  [/\bpath\b/g, "đường dẫn"],
  [/\btoken\b/g, "token"],
  [/\bsecret\b/g, "secret"],
  [/\bsecurity\b/g, "bảo mật"],
  [/\bsafety\b/g, "an toàn"],
  [/\blog\b/g, "log"],
  [/\blogging\b/g, "ghi log"],
  [/\bdiagnostics\b/g, "chẩn đoán"],
  [/\btrace\b/g, "trace"],
  [/\bcache\b/g, "cache"],
  [/\btimeout\b/g, "timeout"],
  [/\blimit\b/g, "giới hạn"],
  [/\blimits\b/g, "giới hạn"],
  [/\bbudget\b/g, "ngân sách"],
  [/\bcharacters\b/g, "ký tự"],
  [/\bchar\b/g, "ký tự"],
  [/\bchars\b/g, "ký tự"],
  [/\btokens\b/g, "token"],
];

function looksEnglishConfigText(value: string): boolean {
  return (
    /[A-Za-z]/.test(value) &&
    !/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(value)
  );
}

function applyConfigTranslations(value: string, replacements: Array<[RegExp, string]>): string {
  let translated = value;
  for (const [pattern, replacement] of replacements) {
    translated = translated.replace(pattern, replacement);
  }
  return translated
    .replace(/\bper-agent\b/g, "theo từng agent")
    .replace(/\bper-message\b/g, "theo từng tin nhắn")
    .replace(/\bper-surface\b/g, "theo từng bề mặt")
    .replace(/\bstartup\b/g, "khởi động")
    .replace(/\bstartup-check\b/g, "kiểm tra khởi động")
    .replace(/\bupdate-channel\b/g, "kênh cập nhật")
    .replace(/\s+/g, " ")
    .trim();
}

const CONFIG_TAG_TRANSLATIONS: Record<string, string> = {
  access: "truy cập",
  advanced: "nâng cao",
  automation: "tự động hóa",
  media: "media",
  models: "mô hình",
  observability: "quan sát",
  performance: "hiệu năng",
  privacy: "riêng tư",
  reliability: "độ tin cậy",
  security: "bảo mật",
  storage: "lưu trữ",
  tools: "công cụ",
  "url-secret": "URL secret",
};

export function translateConfigLabel(value: string | undefined): string | undefined {
  if (!value || i18n.getLocale() === "en") {
    return value;
  }
  const exact = CONFIG_EXACT_TRANSLATIONS[value];
  if (exact) {
    return exact;
  }
  if (!looksEnglishConfigText(value)) {
    return value;
  }
  const translated = applyConfigTranslations(value, CONFIG_PHRASE_TRANSLATIONS);
  return translated || value;
}

export function translateConfigHelp(value: string | undefined): string | undefined {
  if (!value || i18n.getLocale() === "en") {
    return value;
  }
  const exact = CONFIG_EXACT_TRANSLATIONS[value];
  if (exact) {
    return exact;
  }
  if (!looksEnglishConfigText(value)) {
    return value;
  }
  const translated = applyConfigTranslations(value, [
    ...CONFIG_DESCRIPTION_TRANSLATIONS,
    ...CONFIG_PHRASE_TRANSLATIONS,
  ]);
  return translated || value;
}

export function translateConfigTag(value: string): string {
  if (i18n.getLocale() === "en") {
    return value;
  }
  return CONFIG_TAG_TRANSLATIONS[value] ?? CONFIG_TAG_TRANSLATIONS[value.toLowerCase()] ?? value;
}

const SENSITIVE_KEY_WHITELIST_SUFFIXES = [
  "maxtokens",
  "maxoutputtokens",
  "maxinputtokens",
  "maxcompletiontokens",
  "contexttokens",
  "totaltokens",
  "tokencount",
  "tokenlimit",
  "tokenbudget",
  "passwordfile",
] as const;

const SENSITIVE_PATTERNS = [
  /token$/i,
  /password/i,
  /secret/i,
  /api.?key/i,
  /serviceaccount(?:ref)?$/i,
];

const ENV_VAR_PLACEHOLDER_PATTERN = /^\$\{[^}]*\}$/;

export const REDACTED_PLACEHOLDER = "[redacted - click reveal to view]";

const MAX_SENSITIVE_SCAN_DEPTH = 64;
const MAX_SENSITIVE_SCAN_NODES = 20_000;

type SensitiveScanState = {
  visited: number;
};

function createSensitiveScanState(): SensitiveScanState {
  return { visited: 0 };
}

function enterSensitiveScanNode(state: SensitiveScanState, depth: number): boolean {
  if (depth > MAX_SENSITIVE_SCAN_DEPTH) {
    return false;
  }
  state.visited += 1;
  if (state.visited > MAX_SENSITIVE_SCAN_NODES) {
    return false;
  }
  return true;
}

function isEnvVarPlaceholder(value: string): boolean {
  return ENV_VAR_PLACEHOLDER_PATTERN.test(value.trim());
}

export function isSensitiveConfigPath(path: string): boolean {
  const lowerPath = normalizeLowercaseStringOrEmpty(path);
  const whitelisted = SENSITIVE_KEY_WHITELIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
  return !whitelisted && SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

function isSensitiveLeafValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0 && !isEnvVarPlaceholder(value);
  }
  return value !== undefined && value !== null;
}

function isHintSensitive(hint: ConfigUiHint | undefined): boolean {
  return hint?.sensitive ?? false;
}

export function hasSensitiveConfigData(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): boolean {
  return hasSensitiveConfigDataInner(value, path, hints, createSensitiveScanState(), 0);
}

function hasSensitiveConfigDataInner(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
  scan: SensitiveScanState,
  depth: number,
): boolean {
  if (!enterSensitiveScanNode(scan, depth)) {
    return true;
  }

  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = isHintSensitive(hint) || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item, index) =>
      hasSensitiveConfigDataInner(item, [...path, index], hints, scan, depth + 1),
    );
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) =>
      hasSensitiveConfigDataInner(childValue, [...path, childKey], hints, scan, depth + 1),
    );
  }

  return false;
}

export function countSensitiveConfigValues(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
): number {
  return countSensitiveConfigValuesInner(value, path, hints, createSensitiveScanState(), 0);
}

function countSensitiveConfigValuesInner(
  value: unknown,
  path: Array<string | number>,
  hints: ConfigUiHints,
  scan: SensitiveScanState,
  depth: number,
): number {
  if (!enterSensitiveScanNode(scan, depth)) {
    return 1;
  }

  if (value == null) {
    return 0;
  }

  const key = pathKey(path);
  const hint = hintForPath(path, hints);
  const pathIsSensitive = isHintSensitive(hint) || isSensitiveConfigPath(key);

  if (pathIsSensitive && isSensitiveLeafValue(value)) {
    return 1;
  }

  if (Array.isArray(value)) {
    return value.reduce(
      (count, item, index) =>
        count + countSensitiveConfigValuesInner(item, [...path, index], hints, scan, depth + 1),
      0,
    );
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (count, [childKey, childValue]) =>
        count +
        countSensitiveConfigValuesInner(childValue, [...path, childKey], hints, scan, depth + 1),
      0,
    );
  }

  return 0;
}
