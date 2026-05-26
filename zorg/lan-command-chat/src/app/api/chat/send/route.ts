import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { appConfig } from "@/lib/env";
import { callGateway } from "@/lib/gatewayWs";
import { logAppActivity, logInboundChatToDb } from "@/lib/chatIngest";
import { compileSystemPrompt } from "@/lib/promptCompiler";

interface ChatSendResponse {
  runId?: string;
  status?: string;
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];

    if (!message && attachments.length === 0) {
      return NextResponse.json({ error: "Message or attachment is required" }, { status: 400 });
    }

    const normalizedAttachments = attachments
      .map((file: any) => ({
        name: typeof file?.name === "string" ? file.name : "file",
        type: typeof file?.type === "string" ? file.type : "application/octet-stream",
        size: typeof file?.size === "number" ? file.size : 0,
        url: typeof file?.url === "string" ? file.url : "",
        path: typeof file?.path === "string" ? file.path : "",
        containerPath: typeof file?.containerPath === "string" ? file.containerPath : "",
      }))
      .filter((file: any) => file.url || file.path || file.containerPath);

    const attachmentLines = normalizedAttachments
      .map((file: any) => {
        const { name, type, url } = file;
        const size = file.size ? `${Math.round(file.size / 1024)}KB` : "";
        const localPath = file.path;
        const containerPath = file.containerPath;
        if (!url && !localPath && !containerPath) return "";
        return `- ${name} (${type}${size ? `, ${size}` : ""})${url ? ` -> ${url}` : ""}${localPath ? ` | local_path=${localPath}` : ""}${containerPath ? ` | container_path=${containerPath}` : ""}`;
      })
      .filter(Boolean);

    const envelope = `Conversation info (untrusted metadata):\n\`\`\`json\n{"conversation_label":"${appConfig.sourceLabel}"}\n\`\`\``;

    const userInput = [
      message,
      attachmentLines.length ? "\nAttached files (local LAN links):\n" + attachmentLines.join("\n") : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    let compiledPrompt: string | null = null;
    try {
      const compiled = await compileSystemPrompt(userInput, {
        source: "lan-chat",
        sessionKey: appConfig.sessionKey,
      });
      compiledPrompt = typeof compiled?.compiled_prompt === "string" ? compiled.compiled_prompt : null;
    } catch (err) {
      console.error("prompt compiler fallback", err);
    }

    const finalMessage = [envelope, compiledPrompt || userInput].filter(Boolean).join("\n\n");

    await logAppActivity({
      activityKey: `send:${Date.now()}:${message.slice(0, 80)}`,
      activityType: "chat_send",
    });

    await logInboundChatToDb({
      sessionKey: appConfig.sessionKey,
      source: "lan-chat",
      message,
      compiledPrompt,
      attachmentSummary: normalizedAttachments.length ? JSON.stringify(normalizedAttachments) : null,
    });

    const idempotencyKey = randomUUID();

    const result = await callGateway<ChatSendResponse>({
      method: "chat.send",
      params: {
        sessionKey: appConfig.sessionKey,
        message: finalMessage,
        idempotencyKey,
        deliver: false,
      },
      timeoutMs: appConfig.gatewayTimeoutMs,
    });

    return NextResponse.json({
      runId: result?.runId || idempotencyKey,
      status: result?.status || "started",
    });
  } catch (error) {
    console.error("chat.send failed", error);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
