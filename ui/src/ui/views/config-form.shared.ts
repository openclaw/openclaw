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
  Updates: "Cập nhật",
  CLI: "CLI",
  Diagnostics: "Chẩn đoán",
  Logging: "Nhật ký",
  Gateway: "Gateway",
  "Node Host": "Node host",
  Agents: "Agent",
  Tools: "Công cụ",
  Bindings: "Binding",
  Audio: "Âm thanh",
  Models: "Mô hình",
  Messages: "Tin nhắn",
  Commands: "Lệnh",
  Session: "Phiên",
  Cron: "Cron",
  Hooks: "Hook",
  UI: "UI",
  Browser: "Trình duyệt",
  Talk: "Giọng nói",
  Channels: "Kênh",
  Skills: "Kỹ năng",
  Plugins: "Plugin",
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
  ACP: "ACP",
  MCP: "MCP",
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
};

const CONFIG_PHRASE_TRANSLATIONS: Array<[RegExp, string]> = [
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
  [/\bConfigure this when\b/g, "Cấu hình mục này khi"],
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
