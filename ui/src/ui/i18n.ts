export type Locale = "en" | "ar";
export type LanguageSetting = "system" | Locale;

type TranslationValue = string | ((vars: Record<string, string | number>) => string);
type TranslationTable = Record<string, TranslationValue>;

const translations: Record<Locale, TranslationTable> = {
  en: {
    "app.brand.subtitle": "Gateway Dashboard",
    "app.health": "Health",
    "app.status.ok": "OK",
    "app.status.offline": "Offline",
    "nav.group.chat": "Chat",
    "nav.group.control": "Control",
    "nav.group.agent": "Agent",
    "nav.group.settings": "Settings",
    "nav.resources": "Resources",
    "nav.docs": "Docs",
    "nav.expand": "Expand sidebar",
    "nav.collapse": "Collapse sidebar",
    "tab.overview": "Overview",
    "tab.channels": "Channels",
    "tab.instances": "Instances",
    "tab.sessions": "Sessions",
    "tab.cron": "Cron Jobs",
    "tab.skills": "Skills",
    "tab.nodes": "Nodes",
    "tab.chat": "Chat",
    "tab.config": "Config",
    "tab.debug": "Debug",
    "tab.logs": "Logs",
    "subtitle.overview": "Gateway status, entry points, and a fast health read.",
    "subtitle.channels": "Manage channels and settings.",
    "subtitle.instances": "Presence beacons from connected clients and nodes.",
    "subtitle.sessions": "Inspect active sessions and adjust per-session defaults.",
    "subtitle.cron": "Schedule wakeups and recurring agent runs.",
    "subtitle.skills": "Manage skill availability and API key injection.",
    "subtitle.nodes": "Paired devices, capabilities, and command exposure.",
    "subtitle.chat": "Direct gateway chat session for quick interventions.",
    "subtitle.config": "Edit ~/.clawdbot/moltbot.json safely.",
    "subtitle.debug": "Gateway snapshots, events, and manual RPC calls.",
    "subtitle.logs": "Live tail of the gateway file logs.",
    "chat.disabled": "Disconnected from gateway.",
    "chat.loading": "Loading chat…",
    "chat.compaction.active": "Compacting context...",
    "chat.compaction.done": "Context compacted",
    "chat.focus.exit": "Exit focus mode",
    "chat.queue.title": ({ count }) => `Queued (${count})`,
    "chat.queue.image": ({ count }) => `Image (${count})`,
    "chat.queue.remove": "Remove queued message",
    "chat.compose.label": "Message",
    "chat.compose.placeholder":
      "Message (↩ to send, Shift+↩ for line breaks, paste images)",
    "chat.compose.placeholder.attachments": "Add a message or paste more images...",
    "chat.compose.placeholder.disconnected": "Connect to the gateway to start chatting…",
    "chat.compose.send": "Send",
    "chat.compose.queue": "Queue",
    "chat.compose.stop": "Stop",
    "chat.compose.new": "New session",
    "chat.compose.attachment.preview": "Attachment preview",
    "chat.compose.attachment.remove": "Remove attachment",
    "chat.history.notice": ({ limit, hidden }) =>
      `Showing last ${limit} messages (${hidden} hidden).`,
    "chat.controls.refresh": "Refresh chat data",
    "chat.controls.thinking": "Toggle assistant thinking/working output",
    "chat.controls.focus": "Toggle focus mode (hide sidebar + page header)",
    "chat.controls.disabled": "Disabled during onboarding",
    "theme.label": "Theme",
    "theme.system": "System",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "language.label": "Language",
    "language.system": "System",
    "language.en": "English",
    "language.ar": "Arabic",
    "voice.start": "Start voice input",
    "voice.stop": "Stop voice input",
    "voice.unsupported": "Voice input not supported",
    "voice.speak": "Speak last reply",
    "voice.speak.stop": "Stop speaking",
    "voice.error": "Voice input failed. Check your microphone permissions.",
  },
  ar: {
    "app.brand.subtitle": "لوحة تحكم البوابة",
    "app.health": "الصحة",
    "app.status.ok": "جيد",
    "app.status.offline": "غير متصل",
    "nav.group.chat": "المحادثة",
    "nav.group.control": "التحكم",
    "nav.group.agent": "الوكيل",
    "nav.group.settings": "الإعدادات",
    "nav.resources": "الموارد",
    "nav.docs": "الوثائق",
    "nav.expand": "توسيع الشريط الجانبي",
    "nav.collapse": "تصغير الشريط الجانبي",
    "tab.overview": "نظرة عامة",
    "tab.channels": "القنوات",
    "tab.instances": "الأجهزة",
    "tab.sessions": "الجلسات",
    "tab.cron": "مهام كرون",
    "tab.skills": "المهارات",
    "tab.nodes": "العقد",
    "tab.chat": "المحادثة",
    "tab.config": "التهيئة",
    "tab.debug": "التصحيح",
    "tab.logs": "السجلات",
    "subtitle.overview": "حالة البوابة ونقاط الدخول وقراءة سريعة للصحة.",
    "subtitle.channels": "إدارة القنوات والإعدادات.",
    "subtitle.instances": "إشارات التواجد من العملاء والعقد المتصلة.",
    "subtitle.sessions": "عرض الجلسات النشطة وضبط الافتراضات.",
    "subtitle.cron": "جدولة التنبيهات وتشغيلات الوكيل المتكررة.",
    "subtitle.skills": "إدارة تفعيل المهارات وحقن مفاتيح API.",
    "subtitle.nodes": "الأجهزة المقترنة والقدرات وصلاحيات الأوامر.",
    "subtitle.chat": "جلسة محادثة مباشرة مع البوابة للتدخل السريع.",
    "subtitle.config": "تعديل ~/.clawdbot/moltbot.json بأمان.",
    "subtitle.debug": "لقطات البوابة والأحداث واستدعاءات RPC اليدوية.",
    "subtitle.logs": "عرض مباشر لسجلات ملفات البوابة.",
    "chat.disabled": "غير متصل بالبوابة.",
    "chat.loading": "جارٍ تحميل المحادثة…",
    "chat.compaction.active": "جارٍ ضغط السياق...",
    "chat.compaction.done": "تم ضغط السياق",
    "chat.focus.exit": "الخروج من وضع التركيز",
    "chat.queue.title": ({ count }) => `قائمة الانتظار (${count})`,
    "chat.queue.image": ({ count }) => `صورة (${count})`,
    "chat.queue.remove": "إزالة الرسالة من الانتظار",
    "chat.compose.label": "الرسالة",
    "chat.compose.placeholder":
      "اكتب رسالة (↩ للإرسال، Shift+↩ لأسطر جديدة، يمكن لصق الصور)",
    "chat.compose.placeholder.attachments": "أضف رسالة أو الصق المزيد من الصور...",
    "chat.compose.placeholder.disconnected": "اتصل بالبوابة لبدء المحادثة…",
    "chat.compose.send": "إرسال",
    "chat.compose.queue": "انتظار",
    "chat.compose.stop": "إيقاف",
    "chat.compose.new": "جلسة جديدة",
    "chat.compose.attachment.preview": "معاينة المرفق",
    "chat.compose.attachment.remove": "إزالة المرفق",
    "chat.history.notice": ({ limit, hidden }) =>
      `عرض آخر ${limit} رسالة (مخفي ${hidden}).`,
    "chat.controls.refresh": "تحديث بيانات المحادثة",
    "chat.controls.thinking": "إظهار تفكير/عمل المساعد",
    "chat.controls.focus": "تفعيل وضع التركيز (إخفاء الشريط الجانبي والعنوان)",
    "chat.controls.disabled": "غير متاح أثناء الإعداد",
    "theme.label": "المظهر",
    "theme.system": "النظام",
    "theme.light": "فاتح",
    "theme.dark": "داكن",
    "language.label": "اللغة",
    "language.system": "لغة النظام",
    "language.en": "الإنجليزية",
    "language.ar": "العربية",
    "voice.start": "بدء الإدخال الصوتي",
    "voice.stop": "إيقاف الإدخال الصوتي",
    "voice.unsupported": "الإدخال الصوتي غير مدعوم",
    "voice.speak": "قراءة آخر رد صوتيًا",
    "voice.speak.stop": "إيقاف القراءة الصوتية",
    "voice.error": "فشل الإدخال الصوتي. تحقّق من أذونات الميكروفون.",
  },
};

export function resolveLocale(setting: LanguageSetting, browserLanguage?: string): Locale {
  if (setting === "en" || setting === "ar") return setting;
  const candidate = (browserLanguage || navigator.language || "").toLowerCase();
  if (candidate.startsWith("ar")) return "ar";
  return "en";
}

export function isRtl(locale: Locale): boolean {
  return locale === "ar";
}

export function applyLocaleToDocument(locale: Locale) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.lang = locale;
  root.dir = isRtl(locale) ? "rtl" : "ltr";
}

export function t(
  locale: Locale,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const entry = translations[locale]?.[key] ?? translations.en?.[key];
  if (!entry) return key;
  if (typeof entry === "function") return entry(vars);
  return entry;
}
