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
  "Node Host": "Máy chủ node",
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
  UI: "Giao diện UI",
  Theme: "Chủ đề",
  Browser: "Trình duyệt",
  Talk: "Giọng nói",
  Channels: "Kênh",
  Skills: "Kỹ năng",
  Plugins: "Tiện ích",
  Discovery: "Khám phá",
  Presence: "Hiện diện",
  "Voice Wake": "Đánh thức bằng giọng nói",
  Metadata: "Siêu dữ liệu",
  Environment: "Môi trường",
  "Environment Variables": "Biến môi trường",
  Authentication: "Xác thực",
  Broadcast: "Phát sóng",
  "Canvas Host": "Máy chủ canvas",
  Secrets: "Bí mật",
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
  "Native Commands": "Lệnh native",
  "Native Skill Commands": "Lệnh kỹ năng native",
  "Command Elevated Access Rules": "Quy tắc truy cập lệnh nâng quyền",
  "Bash Foreground Window (ms)": "Cửa sổ foreground Bash (ms)",
  "Use Access Groups": "Dùng nhóm truy cập",
  "Cron Store Path": "Đường dẫn kho Cron",
  "Cron Legacy Webhook (Deprecated)": "Webhook Cron cũ (không khuyến nghị)",
  "Cron Webhook Bearer Token": "Bearer token webhook Cron",
  "Cron Run Log Pruning": "Dọn nhật ký chạy Cron",
  "Hooks Endpoint Path": "Đường dẫn endpoint hook",
  "Hooks Presets": "Preset hook",
  "Hooks Transforms Directory": "Thư mục transform hook",
  "Hook Mapping Deliver Reply": "Gửi phản hồi từ ánh xạ hook",
  "Hook Mapping Allow Unsafe External Content":
    "Cho phép nội dung ngoài không an toàn trong ánh xạ hook",
  "Hook Mapping Delivery Channel": "Kênh gửi của ánh xạ hook",
  "Hook Mapping Delivery Destination": "Đích gửi của ánh xạ hook",
  "Hook Mapping Thinking Override": "Ghi đè mức suy luận của ánh xạ hook",
  "Hook Mapping Timeout (sec)": "Thời gian chờ ánh xạ hook (giây)",
  "Hook Mapping Transform": "Transform ánh xạ hook",
  "Hook Transform Module": "Module transform hook",
  "Hook Transform Export": "Export transform hook",
  "Gmail Hook Account": "Tài khoản hook Gmail",
  "Gmail Hook Label": "Nhãn hook Gmail",
  "Gmail Hook Pub/Sub Topic": "Chủ đề Pub/Sub hook Gmail",
  "Gmail Hook Subscription": "Subscription hook Gmail",
  "Gmail Hook Push Token": "Push token hook Gmail",
  "Gmail Hook Callback URL": "URL callback hook Gmail",
  "Gmail Hook Include Body": "Bao gồm nội dung hook Gmail",
  "Gmail Hook Max Body Bytes": "Dung lượng nội dung tối đa hook Gmail",
  "Gmail Hook Renew Interval (min)": "Khoảng gia hạn hook Gmail (phút)",
  "Gmail Hook Allow Unsafe External Content":
    "Cho phép nội dung ngoài không an toàn trong hook Gmail",
  "Gmail Hook Local Server": "Server cục bộ hook Gmail",
  "Gmail Hook Server Bind Address": "Địa chỉ bind server hook Gmail",
  "Gmail Hook Server Port": "Cổng server hook Gmail",
  "Gmail Hook Server Path": "Đường dẫn server hook Gmail",
  "Gateway Trusted Proxy Auth": "Xác thực proxy tin cậy của Gateway",
  "Gateway Trusted Proxy CIDRs": "CIDR proxy tin cậy của Gateway",
  "Gateway Handshake Timeout": "Thời gian chờ bắt tay Gateway",
  "Gateway Channel Stale Event Threshold (min)": "Ngưỡng sự kiện kênh cũ của Gateway (phút)",
  "Gateway Channel Max Restarts Per Hour": "Số lần khởi động lại kênh tối đa mỗi giờ",
  "Gateway TLS Auto-Generate Cert": "Tự tạo chứng chỉ TLS cho Gateway",
  "Gateway HTTP Endpoints": "Endpoint HTTP của Gateway",
  "Gateway HTTP Security Headers": "Header bảo mật HTTP của Gateway",
  "Strict Transport Security Header": "Header Strict Transport Security",
  "Browser Action Timeout (ms)": "Thời gian chờ thao tác trình duyệt (ms)",
  "Browser Local Launch Timeout (ms)": "Thời gian chờ khởi chạy trình duyệt cục bộ (ms)",
  "Browser Local CDP Ready Timeout (ms)": "Thời gian chờ CDP trình duyệt cục bộ sẵn sàng (ms)",
  "Browser Accent Color": "Màu nhấn trình duyệt",
  "Browser Headless Mode": "Chế độ headless trình duyệt",
  "Browser No-Sandbox Mode": "Chế độ không sandbox trình duyệt",
  "Browser Attach-only Mode": "Chế độ chỉ attach trình duyệt",
  "Browser CDP Port Range Start": "Cổng bắt đầu dải CDP trình duyệt",
  "Browser Profile Driver": "Driver hồ sơ trình duyệt",
  "Browser Profile Headless Mode": "Chế độ headless hồ sơ trình duyệt",
  "Browser Profile Attach-only Mode": "Chế độ chỉ attach hồ sơ trình duyệt",
  "Browser Profile Accent Color": "Màu nhấn hồ sơ trình duyệt",
  "Control UI Assets Root": "Gốc tài nguyên Control UI",
  "Control UI Chat Message Max Width": "Chiều rộng tối đa tin nhắn chat Control UI",
  "Control UI Allowed Origins": "Origin được phép của Control UI",
  "Dangerously Allow Host-Header Origin Fallback":
    "Cho phép fallback origin từ Host header ở chế độ nguy hiểm",
  "Insecure Control UI Auth Toggle": "Công tắc xác thực Control UI không an toàn",
  "Dangerously Disable Control UI Device Auth":
    "Tắt xác thực thiết bị Control UI ở chế độ nguy hiểm",
  "Gateway Push Delivery": "Gửi push qua Gateway",
  "Gateway APNs Delivery": "Gửi APNs qua Gateway",
  "Gateway APNs Relay": "Relay APNs của Gateway",
  "Gateway APNs Relay Base URL": "URL gốc relay APNs của Gateway",
  "Gateway APNs Relay Timeout (ms)": "Thời gian chờ relay APNs của Gateway (ms)",
  "OpenAI Chat Completions Endpoint": "Endpoint Chat Completions OpenAI",
  "OpenAI Chat Completions Max Body Bytes": "Dung lượng body tối đa Chat Completions OpenAI",
  "OpenAI Chat Completions Max Image Parts": "Số phần ảnh tối đa Chat Completions OpenAI",
  "OpenAI Chat Completions Max Total Image Bytes":
    "Tổng dung lượng ảnh tối đa Chat Completions OpenAI",
  "Assistant Appearance": "Giao diện trợ lý",
  "Assistant Name": "Tên trợ lý",
  "Assistant Avatar": "Ảnh đại diện trợ lý",
  "Wizard Last Run Timestamp": "Thời điểm chạy trình hướng dẫn gần nhất",
  "Wizard Last Run Version": "Phiên bản chạy trình hướng dẫn gần nhất",
  "Wizard Last Run Commit": "Commit chạy trình hướng dẫn gần nhất",
  "Accent Color": "Màu nhấn",
  "Group Chat Rules": "Quy tắc chat nhóm",
  "Group Mention Patterns": "Mẫu nhắc tên trong nhóm",
  "Group Visible Replies": "Phản hồi hiển thị trong nhóm",
  "Visible Replies": "Phản hồi hiển thị",
  "Queue Capacity": "Dung lượng hàng đợi",
  "Suppress Tool Error Warnings": "Ẩn cảnh báo lỗi công cụ",
  "Ack Reaction Emoji": "Emoji reaction xác nhận",
  "Ack Reaction Scope": "Phạm vi reaction xác nhận",
  "Remove Ack Reaction After Reply": "Xóa reaction xác nhận sau khi phản hồi",
  "Status Reactions": "Reaction trạng thái",
  "Enable Status Reactions": "Bật reaction trạng thái",
  "Status Reaction Emojis": "Emoji reaction trạng thái",
  "Status Reaction Timing": "Thời điểm reaction trạng thái",
  "Heartbeat Show Alerts": "Hiển thị cảnh báo heartbeat",
  "Heartbeat Show OK": "Hiển thị heartbeat OK",
  "Heartbeat Use Indicator": "Dùng chỉ báo heartbeat",
  "Talk Speech Locale": "Ngôn ngữ giọng nói Talk",
  "Talk Interrupt on Speech": "Ngắt Talk khi có giọng nói",
  "Talk Silence Timeout (ms)": "Thời gian chờ im lặng Talk (ms)",
  "Audio Transcription": "Phiên âm âm thanh",
  "Audio Transcription Command": "Lệnh phiên âm âm thanh",
  "Audio Transcription Timeout (sec)": "Thời gian chờ phiên âm âm thanh (giây)",
  "Broadcast Strategy": "Chiến lược phát sóng",
  "Broadcast Destination List": "Danh sách đích phát sóng",
  "Agent ACP Harness Agent": "Agent harness ACP",
  "Agent ACP Backend": "Backend ACP của agent",
  "Agent Reasoning Default": "Mặc định reasoning của agent",
  "Agent Fast Mode Default": "Mặc định chế độ nhanh của agent",
  "Default Legacy Embedded Harness Settings": "Cài đặt harness nhúng cũ mặc định",
  "Default Legacy Embedded Harness Runtime": "Runtime harness nhúng cũ mặc định",
  "Agent Legacy Embedded Harness": "Harness nhúng cũ của agent",
  "Agent Legacy Embedded Harness Runtime": "Runtime harness nhúng cũ của agent",
  "Enable Image Understanding": "Bật hiểu ảnh",
  "Image Understanding Max Bytes": "Dung lượng tối đa khi hiểu ảnh",
  "Image Understanding Max Chars": "Số ký tự tối đa khi hiểu ảnh",
  "Image Understanding Prompt": "Prompt hiểu ảnh",
  "Image Understanding Timeout (sec)": "Thời gian chờ hiểu ảnh (giây)",
  "Image Understanding Attachment Policy": "Chính sách tệp đính kèm hiểu ảnh",
  "Image Understanding Models": "Mô hình hiểu ảnh",
  "Image Understanding Scope": "Phạm vi hiểu ảnh",
  "Enable Audio Understanding": "Bật hiểu âm thanh",
  "Audio Understanding Max Bytes": "Dung lượng tối đa khi hiểu âm thanh",
  "Audio Understanding Max Chars": "Số ký tự tối đa khi hiểu âm thanh",
  "Audio Understanding Prompt": "Prompt hiểu âm thanh",
  "Audio Understanding Timeout (sec)": "Thời gian chờ hiểu âm thanh (giây)",
  "Audio Understanding Language": "Ngôn ngữ hiểu âm thanh",
  "Audio Understanding Attachment Policy": "Chính sách tệp đính kèm hiểu âm thanh",
  "Audio Understanding Models": "Mô hình hiểu âm thanh",
  "Audio Understanding Scope": "Phạm vi hiểu âm thanh",
  "Echo Transcript to Chat": "Gửi lại transcript vào chat",
  "Transcript Echo Format": "Định dạng gửi lại transcript",
  "Media Understanding Shared Models": "Mô hình dùng chung để hiểu media",
  "Media Understanding Concurrency": "Số tác vụ hiểu media đồng thời",
  "Async Media Completion Direct Send": "Gửi trực tiếp kết quả media bất đồng bộ",
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
  "Default channel behavior applied across providers when provider-specific settings are not set. Use this to enforce consistent channel posture from one place.":
    "Hành vi kênh mặc định áp dụng cho mọi nhà cung cấp khi chưa có cài đặt riêng. Dùng mục này để giữ tư thế kênh nhất quán từ một nơi.",
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

const CONFIG_WORD_TRANSLATIONS: Record<string, string> = {
  acknowledgement: "xác nhận",
  acknowledgements: "xác nhận",
  ack: "xác nhận",
  action: "hành động",
  actions: "hành động",
  active: "đang hoạt động",
  activity: "hoạt động",
  adapter: "adapter",
  addition: "bổ sung",
  additional: "bổ sung",
  administration: "quản trị",
  admin: "quản trị",
  agent: "agent",
  agents: "agent",
  alias: "bí danh",
  aliases: "bí danh",
  all: "tất cả",
  allow: "cho phép",
  allowed: "được phép",
  allowlist: "danh sách cho phép",
  allowlists: "danh sách cho phép",
  allows: "cho phép",
  always: "luôn",
  applied: "được áp dụng",
  applies: "áp dụng",
  apply: "áp dụng",
  array: "mảng",
  asset: "asset",
  assets: "asset",
  attach: "gắn",
  attachment: "đính kèm",
  attachments: "đính kèm",
  attempts: "lần thử",
  auth: "xác thực",
  authenticate: "xác thực",
  authentication: "xác thực",
  auto: "tự động",
  automatic: "tự động",
  automatically: "tự động",
  avatar: "ảnh đại diện",
  backoff: "backoff",
  background: "nền",
  banner: "banner",
  base: "gốc",
  baseline: "nền",
  bearer: "bearer",
  behavior: "hành vi",
  bind: "bind",
  binding: "liên kết",
  bindings: "liên kết",
  block: "chặn",
  blocked: "bị chặn",
  boolean: "boolean",
  boundary: "ranh giới",
  bounded: "được giới hạn",
  branding: "thương hiệu",
  broad: "rộng",
  browser: "trình duyệt",
  browsers: "trình duyệt",
  buffer: "bộ đệm",
  buffers: "bộ đệm",
  bundled: "đóng gói sẵn",
  bytes: "byte",
  cache: "cache",
  caller: "bên gọi",
  callers: "bên gọi",
  cap: "giới hạn",
  capability: "năng lực",
  capabilities: "năng lực",
  capture: "thu thập",
  captures: "thu thập",
  catalog: "danh mục",
  cert: "chứng chỉ",
  certificate: "chứng chỉ",
  channel: "kênh",
  channels: "kênh",
  chars: "ký tự",
  chat: "chat",
  chats: "chat",
  check: "kiểm tra",
  checks: "kiểm tra",
  chrome: "Chrome",
  client: "client",
  clients: "client",
  color: "màu",
  colored: "có màu",
  command: "lệnh",
  commands: "lệnh",
  compact: "gọn",
  compacting: "nén",
  components: "thành phần",
  concurrent: "đồng thời",
  config: "cấu hình",
  configuration: "cấu hình",
  configured: "đã cấu hình",
  constrain: "giới hạn",
  constraining: "giới hạn",
  constraints: "ràng buộc",
  content: "nội dung",
  contents: "nội dung",
  context: "ngữ cảnh",
  contexts: "ngữ cảnh",
  control: "điều khiển",
  controls: "kiểm soát",
  conversation: "hội thoại",
  conversations: "hội thoại",
  converting: "chuyển đổi",
  core: "lõi",
  cost: "chi phí",
  costs: "chi phí",
  credential: "thông tin xác thực",
  credentials: "thông tin xác thực",
  current: "hiện tại",
  custom: "tùy chỉnh",
  dangerous: "nguy hiểm",
  data: "dữ liệu",
  debounce: "debounce",
  decision: "quyết định",
  decisions: "quyết định",
  default: "mặc định",
  defaults: "mặc định",
  delay: "độ trễ",
  deny: "chặn",
  denied: "bị chặn",
  denylist: "danh sách chặn",
  depth: "độ sâu",
  destination: "đích nhận",
  destinations: "đích nhận",
  detail: "chi tiết",
  details: "chi tiết",
  diagnostics: "chẩn đoán",
  directory: "thư mục",
  disable: "tắt",
  disabled: "đã tắt",
  disables: "tắt",
  discovery: "khám phá",
  display: "hiển thị",
  displayed: "được hiển thị",
  domain: "miền",
  drop: "loại bỏ",
  duration: "thời lượng",
  edge: "biên",
  elevated: "nâng quyền",
  embed: "nhúng",
  embedding: "embedding",
  embeddings: "embedding",
  emitted: "được phát",
  emphasis: "nhấn mạnh",
  enable: "bật",
  enabled: "đã bật",
  enables: "bật",
  endpoint: "endpoint",
  endpoints: "endpoint",
  entries: "mục",
  entry: "mục",
  environment: "môi trường",
  error: "lỗi",
  errors: "lỗi",
  event: "sự kiện",
  events: "sự kiện",
  executable: "tệp chạy",
  execution: "thực thi",
  explicit: "rõ ràng",
  explicitly: "rõ ràng",
  export: "xuất",
  exposure: "phơi bày",
  external: "bên ngoài",
  fallback: "fallback",
  false: "false",
  fast: "nhanh",
  field: "trường",
  fields: "trường",
  file: "tệp",
  files: "tệp",
  filter: "bộ lọc",
  filters: "bộ lọc",
  fingerprint: "vân tay",
  flag: "cờ",
  flags: "cờ",
  flow: "luồng",
  flows: "luồng",
  flush: "xả",
  format: "định dạng",
  formatting: "định dạng",
  forwarded: "được chuyển tiếp",
  forwarding: "chuyển tiếp",
  global: "toàn cục",
  granular: "chi tiết",
  group: "nhóm",
  groups: "nhóm",
  guard: "guard",
  handling: "xử lý",
  hardening: "gia cố",
  hash: "hash",
  headless: "headless",
  heartbeat: "heartbeat",
  headers: "header",
  health: "sức khỏe",
  hidden: "ẩn",
  history: "lịch sử",
  hook: "hook",
  hooks: "hook",
  host: "host",
  hosted: "được host",
  identity: "danh tính",
  import: "nhập",
  imports: "nhập",
  inbound: "chiều vào",
  include: "bao gồm",
  includes: "bao gồm",
  incoming: "đến",
  indicator: "chỉ báo",
  ingestion: "nhận dữ liệu",
  input: "đầu vào",
  inputs: "đầu vào",
  install: "cài đặt",
  installs: "cài đặt",
  instance: "phiên bản",
  instances: "phiên bản",
  instrumentation: "instrumentation",
  interval: "khoảng lặp",
  jitter: "dao động",
  key: "khóa",
  keys: "khóa",
  latency: "độ trễ",
  launch: "khởi chạy",
  launcher: "trình khởi chạy",
  level: "mức",
  lifecycle: "vòng đời",
  limit: "giới hạn",
  limits: "giới hạn",
  line: "dòng",
  lines: "dòng",
  list: "danh sách",
  listener: "listener",
  liveness: "sức sống",
  load: "tải",
  loading: "đang tải",
  local: "cục bộ",
  log: "log",
  logger: "logger",
  logging: "ghi log",
  logs: "log",
  managed: "được quản lý",
  mapping: "ánh xạ",
  mappings: "ánh xạ",
  match: "khớp",
  matching: "khớp",
  max: "tối đa",
  maximum: "tối đa",
  memory: "bộ nhớ",
  message: "tin nhắn",
  messages: "tin nhắn",
  metadata: "siêu dữ liệu",
  metrics: "metric",
  milliseconds: "mili giây",
  min: "tối thiểu",
  minutes: "phút",
  mode: "chế độ",
  model: "mô hình",
  models: "mô hình",
  monitor: "giám sát",
  native: "native",
  network: "mạng",
  node: "node",
  nodes: "node",
  notification: "thông báo",
  notifications: "thông báo",
  object: "đối tượng",
  off: "tắt",
  optional: "tùy chọn",
  origin: "origin",
  origins: "origin",
  outbound: "chiều ra",
  output: "đầu ra",
  outputs: "đầu ra",
  override: "ghi đè",
  overrides: "ghi đè",
  owner: "chủ sở hữu",
  owners: "chủ sở hữu",
  paired: "đã ghép đôi",
  password: "mật khẩu",
  path: "đường dẫn",
  pathing: "đường dẫn",
  paths: "đường dẫn",
  pattern: "mẫu",
  patterns: "mẫu",
  payload: "payload",
  payloads: "payload",
  peer: "peer",
  peers: "peer",
  permission: "quyền",
  permissions: "quyền",
  persisted: "đã lưu",
  persistence: "lưu trữ",
  persona: "persona",
  personas: "persona",
  ping: "ping",
  policy: "chính sách",
  port: "cổng",
  ports: "cổng",
  prefix: "tiền tố",
  prefixes: "tiền tố",
  presence: "hiện diện",
  primary: "chính",
  process: "tiến trình",
  processes: "tiến trình",
  profile: "hồ sơ",
  profiles: "hồ sơ",
  prompt: "prompt",
  prompts: "prompt",
  provider: "nhà cung cấp",
  providers: "nhà cung cấp",
  proxy: "proxy",
  publish: "xuất bản",
  push: "push",
  query: "truy vấn",
  queue: "hàng đợi",
  queued: "đã xếp hàng",
  random: "ngẫu nhiên",
  raise: "tăng",
  rate: "tỷ lệ",
  reaction: "reaction",
  reactions: "reaction",
  read: "đọc",
  readability: "độ dễ đọc",
  reconnect: "kết nối lại",
  redaction: "che dữ liệu nhạy cảm",
  ref: "tham chiếu",
  refs: "tham chiếu",
  registry: "registry",
  reload: "tải lại",
  remote: "từ xa",
  request: "yêu cầu",
  requests: "yêu cầu",
  required: "bắt buộc",
  reset: "reset",
  resource: "tài nguyên",
  resources: "tài nguyên",
  response: "phản hồi",
  responses: "phản hồi",
  restart: "khởi động lại",
  retention: "lưu giữ",
  retry: "thử lại",
  retries: "số lần thử lại",
  route: "route",
  routing: "định tuyến",
  run: "lượt chạy",
  running: "đang chạy",
  runs: "lượt chạy",
  runtime: "runtime",
  safe: "an toàn",
  sample: "mẫu",
  sampling: "lấy mẫu",
  sandbox: "sandbox",
  schedule: "lịch",
  scheduled: "đã lên lịch",
  scheduler: "bộ lập lịch",
  scope: "phạm vi",
  scoped: "theo phạm vi",
  search: "tìm kiếm",
  sec: "giây",
  seconds: "giây",
  secret: "bí mật",
  secrets: "bí mật",
  security: "bảo mật",
  selected: "được chọn",
  sender: "người gửi",
  send: "gửi",
  sends: "gửi",
  server: "server",
  service: "dịch vụ",
  settings: "cài đặt",
  shared: "dùng chung",
  shell: "shell",
  signal: "tín hiệu",
  signals: "tín hiệu",
  silence: "im lặng",
  size: "kích thước",
  snapshot: "snapshot",
  source: "nguồn",
  speech: "giọng nói",
  stable: "ổn định",
  start: "khởi động",
  starts: "khởi động",
  startup: "khởi động",
  state: "trạng thái",
  status: "trạng thái",
  strategy: "chiến lược",
  stream: "stream",
  streaming: "streaming",
  strict: "nghiêm ngặt",
  style: "kiểu",
  subagent: "subagent",
  subagents: "subagent",
  suppress: "ẩn",
  surface: "bề mặt",
  surfaces: "bề mặt",
  target: "đích",
  targets: "đích",
  telemetry: "telemetry",
  template: "mẫu",
  templates: "mẫu",
  text: "văn bản",
  threshold: "ngưỡng",
  timing: "thời điểm",
  title: "tiêu đề",
  token: "token",
  tokens: "token",
  tool: "công cụ",
  tools: "công cụ",
  trace: "trace",
  traces: "trace",
  transcription: "phiên âm",
  transport: "truyền tải",
  trigger: "kích hoạt",
  triggers: "kích hoạt",
  trusted: "tin cậy",
  type: "kiểu",
  types: "kiểu",
  update: "cập nhật",
  updates: "cập nhật",
  upload: "tải lên",
  url: "URL",
  urls: "URL",
  use: "dùng",
  user: "người dùng",
  users: "người dùng",
  value: "giá trị",
  values: "giá trị",
  variable: "biến",
  variables: "biến",
  visibility: "hiển thị",
  visible: "hiển thị",
  voice: "giọng nói",
  wake: "đánh thức",
  window: "cửa sổ",
  windows: "cửa sổ",
  wizard: "trình hướng dẫn",
  workspace: "workspace",
  write: "ghi",
};

const CONFIG_SCHEMA_WORD_TRANSLATIONS: Record<string, string> = {
  ...CONFIG_WORD_TRANSLATIONS,
  a: "một",
  account: "tài khoản",
  accounts: "tài khoản",
  address: "địa chỉ",
  affects: "ảnh hưởng",
  aligned: "căn khớp",
  an: "một",
  and: "và",
  are: "là",
  as: "như",
  aborted: "bị hủy",
  act: "thao tác",
  alerts: "cảnh báo",
  asset: "tài nguyên",
  assets: "tài nguyên",
  assistant: "trợ lý",
  attached: "đính kèm",
  audiences: "nhóm nhận",
  available: "khả dụng",
  avoid: "tránh",
  back: "lại",
  backend: "backend",
  backends: "backend",
  banner: "biểu ngữ",
  based: "dựa trên",
  be: "được",
  being: "đang được",
  billing: "thanh toán",
  binary: "binary",
  broken: "lỗi",
  burst: "đợt",
  bursts: "đợt",
  by: "bởi",
  cache: "bộ nhớ đệm",
  callback: "callback",
  can: "có thể",
  cancelled: "bị hủy",
  canceled: "bị hủy",
  capacity: "dung lượng",
  cleaner: "gọn hơn",
  collector: "collector",
  collision: "xung đột",
  collisions: "xung đột",
  combine: "kết hợp",
  completed: "hoàn tất",
  completion: "hoàn tất",
  completions: "hoàn tất",
  compaction: "nén ngữ cảnh",
  concurrency: "đồng thời",
  confirm: "xác nhận",
  connect: "kết nối",
  consistent: "nhất quán",
  cooldown: "thời gian hồi",
  cooldowns: "thời gian hồi",
  correlate: "đối chiếu",
  curated: "chọn lọc",
  dangerously: "nguy hiểm",
  dedicated: "riêng",
  deliver: "gửi",
  delivered: "được gửi",
  delivery: "gửi",
  deprecated: "không khuyến nghị",
  detect: "phát hiện",
  degraded: "suy giảm",
  device: "thiết bị",
  direct: "trực tiếp",
  directly: "trực tiếp",
  discoverability: "khả năng khám phá",
  defines: "định nghĩa",
  depending: "tùy theo",
  dimensions: "kích thước",
  endpoint: "điểm cuối",
  endpoints: "điểm cuối",
  exact: "chính xác",
  exceed: "vượt",
  exceeds: "vượt",
  example: "ví dụ",
  exposed: "được mở",
  false: "false",
  faster: "nhanh hơn",
  filesystem: "hệ tệp",
  finish: "hoàn tất",
  for: "cho",
  foreground: "foreground",
  from: "từ",
  gives: "bỏ",
  gateway: "Gateway",
  generated: "được tạo",
  handshake: "bắt tay",
  harness: "harness",
  headless: "không giao diện",
  header: "header",
  headers: "header",
  higher: "cao hơn",
  hour: "giờ",
  hours: "giờ",
  hosts: "máy chủ",
  if: "nếu",
  image: "ảnh",
  images: "ảnh",
  in: "trong",
  increase: "tăng",
  indexing: "lập chỉ mục",
  insecure: "không an toàn",
  instead: "thay vì",
  intentionally: "có chủ ý",
  interpreted: "được diễn giải",
  interactive: "tương tác",
  interrupt: "ngắt",
  into: "vào",
  is: "là",
  it: "nó",
  jobs: "job",
  keyed: "theo khóa",
  keep: "giữ",
  language: "ngôn ngữ",
  legacy: "cũ",
  locale: "ngôn ngữ",
  lower: "thấp hơn",
  loaded: "đang tải",
  long: "dài",
  longer: "dài hơn",
  "low-powered": "máy yếu",
  maintained: "được duy trì",
  manual: "thủ công",
  metric: "số liệu",
  metrics: "số liệu",
  minimal: "tối thiểu",
  migrate: "chuyển đổi",
  more: "nhiều hơn",
  name: "tên",
  narrow: "hẹp",
  need: "cần",
  needs: "cần",
  not: "không",
  of: "của",
  old: "cũ",
  on: "khi",
  only: "chỉ",
  ones: "mức",
  operator: "người vận hành",
  operators: "người vận hành",
  operation: "hoạt động",
  optional: "tùy chọn",
  or: "hoặc",
  order: "thứ tự",
  overloaded: "quá tải",
  payload: "payload",
  payloads: "payload",
  per: "theo",
  permanent: "vĩnh viễn",
  plus: "cộng với",
  posture: "tư thế",
  preserve: "giữ lại",
  preserved: "được giữ lại",
  progress: "tiến trình",
  processed: "được xử lý",
  promptly: "kịp thời",
  problems: "sự cố",
  protocol: "giao thức",
  proxy: "proxy",
  record: "ghi nhận",
  recorded: "được ghi nhận",
  recordings: "bản ghi",
  reduce: "giảm",
  relay: "relay",
  relying: "dựa vào",
  remove: "xóa",
  reply: "phản hồi",
  replies: "phản hồi",
  referenced: "được tham chiếu",
  registers: "đăng ký",
  registration: "đăng ký",
  reset: "đặt lại",
  responsiveness: "độ phản hồi",
  results: "kết quả",
  rotate: "xoay vòng",
  rotation: "luân chuyển",
  rotations: "luân chuyển",
  rule: "quy tắc",
  rules: "quy tắc",
  sent: "được gửi",
  set: "đặt",
  sets: "đặt",
  setup: "thiết lập",
  shows: "hiển thị",
  should: "nên",
  shown: "được hiển thị",
  silently: "âm thầm",
  slower: "chậm hơn",
  so: "để",
  specific: "riêng",
  stale: "cũ",
  states: "trạng thái",
  subscription: "subscription",
  support: "hỗ trợ",
  supported: "được hỗ trợ",
  tailnet: "tailnet",
  tagline: "khẩu hiệu",
  textual: "văn bản",
  than: "hơn",
  that: "mà",
  the: "",
  these: "các mục này",
  this: "mục này",
  timeout: "thời gian chờ",
  timeouts: "thời gian chờ",
  to: "để",
  trace: "truy vết",
  traces: "truy vết",
  transcript: "transcript",
  true: "true",
  "text-only": "chỉ văn bản",
  tighter: "chặt hơn",
  understanding: "hiểu",
  unless: "trừ khi",
  unsafe: "không an toàn",
  unset: "chưa đặt",
  upstream: "upstream",
  used: "được dùng",
  uses: "dùng",
  using: "dùng",
  versus: "so với",
  waiting: "chờ",
  warning: "cảnh báo",
  warnings: "cảnh báo",
  want: "muốn",
  warmup: "làm nóng",
  when: "khi",
  where: "nơi",
  whether: "liệu",
  which: "nào",
  while: "trong khi",
  with: "với",
  without: "không có",
  workflows: "workflow",
  you: "bạn",
  your: "của bạn",
};

const CONFIG_PRESERVED_WORDS = new Set([
  "ACP",
  "API",
  "APNs",
  "BCP",
  "CDP",
  "CIDR",
  "CLI",
  "Control",
  "CSS",
  "DM",
  "DNS",
  "Discord",
  "Gemini",
  "Google",
  "HTTP",
  "HTTPS",
  "ID",
  "JSON",
  "LLM",
  "MCP",
  "OpenClaw",
  "OpenTelemetry",
  "OTEL",
  "OTLP",
  "PATH",
  "QMD",
  "Slack",
  "SSH",
  "TLS",
  "TTS",
  "UI",
  "URL",
  "URLs",
  "Web",
  "WebChat",
  "WebSocket",
  "WhatsApp",
]);

function translateConfigWords(value: string): string {
  return value
    .split(/(`[^`]*`)/g)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return part;
      }
      return part.replace(
        /(?<![\p{L}\p{M}_0-9])[A-Za-z][A-Za-z-]*(?![\p{L}\p{M}_0-9])/gu,
        (word) => {
          if (CONFIG_PRESERVED_WORDS.has(word)) {
            return word;
          }
          const exact = CONFIG_SCHEMA_WORD_TRANSLATIONS[word];
          if (exact) {
            return exact;
          }
          const lower = word.toLowerCase();
          return CONFIG_SCHEMA_WORD_TRANSLATIONS[lower] ?? word;
        },
      );
    })
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

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
  [/\bbeing processed silently\b/g, "được xử lý âm thầm"],
  [/\bresults are delivered back to\b/g, "kết quả được gửi lại tới"],
  [/\bgives up waiting\b/g, "bỏ cuộc khi chờ"],
  [/\bimage understanding\b/g, "hiểu ảnh"],
  [/\bcan be interpreted into textual context\b/g, "có thể được diễn giải thành ngữ cảnh văn bản"],
  [/\bwant to avoid image-processing costs\b/g, "muốn tránh chi phí xử lý ảnh"],
  [/\baudio understanding\b/g, "hiểu âm thanh"],
  [/\boperation is cancelled\b/g, "tác vụ bị hủy"],
  [/\bvideo understanding\b/g, "hiểu video"],
  [/\blink understanding\b/g, "hiểu liên kết"],
  [/\bmedia understanding\b/g, "hiểu media"],
  [/\btext-only operation\b/g, "chế độ chỉ văn bản"],
  [/\buser-facing\b/g, "hiển thị cho người dùng"],
  [/\boperator-facing\b/g, "hướng tới người vận hành"],
  [/\bclean rendering\b/g, "hiển thị sạch"],
  [/\bUI interactions\b/g, "tương tác UI"],
  [/\bhealthy waits\b/g, "các lượt chờ hợp lệ"],
  [/\blow-powered hosts\b/g, "máy yếu"],
  [
    /\blocal client can connect during startup warmup\b/g,
    "client cục bộ có thể kết nối trong lúc khởi động",
  ],
  [/\bsurface problems promptly\b/g, "hiển thị sự cố kịp thời"],
  [/\bchat responsiveness\b/g, "độ phản hồi chat"],
  [/\bMigrate to\b/g, "Chuyển sang"],
  [/\bdepending on\b/g, "tùy theo"],
  [/\bstill takes precedence\b/g, "vẫn được ưu tiên"],
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
  translated = translated
    .replace(/\bper-agent\b/g, "theo từng agent")
    .replace(/\bper-message\b/g, "theo từng tin nhắn")
    .replace(/\bper-surface\b/g, "theo từng bề mặt")
    .replace(/\bstartup\b/g, "khởi động")
    .replace(/\bstartup-check\b/g, "kiểm tra khởi động")
    .replace(/\bupdate-channel\b/g, "kênh cập nhật")
    .replace(/\s+/g, " ")
    .trim();
  return translateConfigWords(translated);
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
