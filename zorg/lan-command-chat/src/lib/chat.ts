export type ChatRole = "assistant" | "user" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp?: number;
}

interface GatewayMessageBlock {
  type?: string;
  text?: string;
}

interface GatewayMessage {
  id?: string;
  role?: string;
  content?: unknown;
  text?: string;
  timestamp?: number;
}

function stripInjectedEnvelope(text: string): string {
  let out = text;

  out = out.replace(
    /^Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i,
    "",
  );

  const hasCompiledPrompt = /SYSTEM PROMPT \(DYNAMICALLY COMPILED\)/i.test(out);
  if (hasCompiledPrompt) {
    const userInputMatch = out.match(/User Input:\s*([\s\S]*)$/i);
    if (userInputMatch?.[1]) {
      out = userInputMatch[1];
    }
  }

  return out.trim();
}

function sanitizeText(text: string): string {
  const stripped = stripInjectedEnvelope(
    text.replace(/\[\[\s*reply_to_current\s*\]\]|\[\[\s*reply_to\s*:\s*[^\]]+\]\]/gi, "").trim(),
  );

  if (
    /^⚠️\s*📝\s*Edit:/i.test(stripped) ||
    /^📝\s*Edit:/i.test(stripped) ||
    /⚠️\s*📝\s*Edit:\s+in\s+/i.test(stripped) ||
    /\bEdit:\s+in\s+.*\s+failed/i.test(stripped) ||
    /tool call .* failed/i.test(stripped) ||
    /\/lan-chat\/src\/.*failed/i.test(stripped)
  ) {
    return "";
  }

  return stripped;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const typed = block as GatewayMessageBlock;
        if (typed.type && typed.type !== "text") return "";
        return typeof typed.text === "string" ? typed.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && "text" in (content as Record<string, unknown>)) {
    const maybeText = (content as Record<string, unknown>).text;
    if (typeof maybeText === "string") return maybeText;
  }
  return "";
}

function normalizeRole(role?: string): ChatRole | null {
  if (!role) return null;
  if (role === "assistant" || role === "user" || role === "system") return role;
  return null;
}

export function normalizeMessages(messages: unknown[]): ChatMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages.flatMap((message, index) => {
    if (!message || typeof message !== "object") return [];
    const msg = message as GatewayMessage;
    const role = normalizeRole(msg.role);
    if (!role) return [];
    const textRaw = msg.text?.trim?.() || extractTextFromContent(msg.content);
    const text = sanitizeText(textRaw);
    if (!text) return [];
    const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
    const fallbackId = `${role}-${timestamp ?? Date.now()}-${index}`;
    return [
      {
        id: msg.id || fallbackId,
        role,
        text,
        timestamp,
      },
    ];
  });
}
