const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
const OPERATOR_TARGET = process.env.OPENCLAW_ACCESS_REQUEST_OPERATOR_TARGET?.trim();
const ACCESS_PHRASE = process.env.OPENCLAW_ACCESS_REQUEST_PHRASE?.trim();
const OPERATOR_CHANNEL = process.env.OPENCLAW_ACCESS_REQUEST_OPERATOR_CHANNEL?.trim() || "whatsapp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeNotificationField(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return JSON.stringify(fallback);
  }
  const normalized =
    value
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/[*_~`]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || fallback;
  return JSON.stringify(normalized);
}

function resolveApprovalCommands(params: {
  channelId: unknown;
  senderId: unknown;
}): { approve: string; remove: string } | null {
  if (typeof params.channelId !== "string" || typeof params.senderId !== "string") {
    return null;
  }
  const hasStableIdentity =
    (params.channelId === "telegram" && /^-?\d+$/.test(params.senderId)) ||
    (params.channelId === "whatsapp" && /^\+\d+$/.test(params.senderId));
  if (!hasStableIdentity) {
    return null;
  }
  return {
    approve: `/allowlist add dm --channel ${params.channelId} --group restricted ${params.senderId}`,
    remove: `/allowlist remove dm --channel ${params.channelId} ${params.senderId}`,
  };
}

const handler = async (event: unknown) => {
  if (!GATEWAY_TOKEN || !OPERATOR_TARGET || !ACCESS_PHRASE) return;
  if (!isRecord(event) || event.type !== "message" || event.action !== "pre-auth") return;
  if (!isRecord(event.context)) return;

  const { senderId, senderName, content, channelId } = event.context;
  if (typeof content !== "string" || content.trim() !== ACCESS_PHRASE) return;

  const commands = resolveApprovalCommands({ channelId, senderId });
  const notification = [
    "Access request received",
    "",
    `ID (untrusted): ${sanitizeNotificationField(senderId, "Unknown")}`,
    `Name (untrusted): ${sanitizeNotificationField(senderName, "Unknown")}`,
    `Channel (untrusted): ${sanitizeNotificationField(channelId, "Unknown")}`,
    ...(commands
      ? [
          "",
          "To approve:",
          commands.approve,
          "",
          'To use a different group, replace "restricted" with:',
          "trusted | partner | friends | family | work",
          "",
          "To change the group later: run the same command with the desired group.",
          "",
          "To remove:",
          commands.remove,
        ]
      : [
          "",
          "Approval command unavailable: the channel has not exposed a stable allowlist identity.",
          "Review the request again after a stable sender ID is available.",
        ]),
  ].join("\n");

  try {
    const response = await fetch("http://127.0.0.1:18789/tools/invoke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        tool: "message",
        action: "send",
        args: {
          channel: OPERATOR_CHANNEL,
          target: OPERATOR_TARGET,
          message: notification,
        },
        sessionKey: "main",
      }),
    });
    const result = await response.text();
    console.log("[access-request] Response:", response.status, result);
  } catch (err) {
    console.error("[access-request] Notification failed:", err);
  }
};

export default handler;
