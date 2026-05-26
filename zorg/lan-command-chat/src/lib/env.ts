export const appConfig = {
  sessionKey: process.env.GATEWAY_SESSION_KEY?.trim() || "agent:main:main",
  sourceLabel: process.env.CHAT_SOURCE_LABEL?.trim() || "LAN Console",
  historyLimit: Number.parseInt(process.env.CHAT_HISTORY_LIMIT || "50", 10),
  gatewayTimeoutMs: Number.parseInt(process.env.GATEWAY_CALL_TIMEOUT_MS || "15000", 10),
  statusTimeoutMs: Number.parseInt(process.env.OPENCLAW_STATUS_TIMEOUT_MS || "3000", 10),
  kokoroBase: process.env.KOKORO_BASE?.trim() || "",
  kokoroModel: process.env.KOKORO_MODEL?.trim() || "kokoro",
  kokoroVoice: process.env.KOKORO_VOICE?.trim() || "",
  chatterboxBase: process.env.CHATTERBOX_BASE?.trim() || "",
  chatterboxVoice: process.env.CHATTERBOX_VOICE?.trim() || "",
  openaiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
  whisperModel: process.env.WHISPER_MODEL?.trim() || "whisper-1",
};

if (!Number.isFinite(appConfig.historyLimit) || appConfig.historyLimit <= 0) {
  appConfig.historyLimit = 50;
}

if (!Number.isFinite(appConfig.gatewayTimeoutMs) || appConfig.gatewayTimeoutMs <= 0) {
  appConfig.gatewayTimeoutMs = 15000;
}

if (!Number.isFinite(appConfig.statusTimeoutMs) || appConfig.statusTimeoutMs <= 0) {
  appConfig.statusTimeoutMs = 3000;
}
