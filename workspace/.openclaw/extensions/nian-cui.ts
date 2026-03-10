/**
 * 念·萃 (Niàn Cuì) — Memory Extraction Plugin
 *
 * Hooks into agent_end to extract key facts from conversations
 * and persist them to each agent's memory/episodes.md file.
 *
 * Part of the 無極 memory system (念).
 * M1 milestone: agents gain autonomous memory.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const EXTRACTION_PROMPT = `You are a memory extraction system. Given a conversation between a user and an AI agent, extract the key facts worth remembering for future interactions.

Rules:
- Extract 3-7 facts maximum
- Focus on: user preferences, decisions made, problems solved, action items, people mentioned, important dates
- Skip: greetings, small talk, system messages, tool call details
- Each fact should be one concise sentence
- Use the same language as the conversation (usually Chinese)
- If the conversation is too short or trivial, return NONE

Output format (one fact per line):
- fact 1
- fact 2
- ...

Or just: NONE`;

function extractTextFromMessages(messages: unknown[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;
    if (role !== "user" && role !== "assistant") continue;

    const content = m.content;
    if (typeof content === "string") {
      lines.push(`${role}: ${content.slice(0, 2000)}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && "text" in block) {
          lines.push(`${role}: ${(block as { text: string }).text.slice(0, 2000)}`);
        }
      }
    }
  }
  return lines.slice(-30).join("\n");
}

export default function register(api: OpenClawPluginApi) {
  const logger = api.logger;

  api.on("agent_end", async (event, ctx) => {
    const agentId = ctx.agentId;
    const workspaceDir = ctx.workspaceDir;

    if (!agentId || !workspaceDir) {
      return;
    }

    // Only process successful conversations with enough messages
    if (!event.success || !event.messages || event.messages.length < 4) {
      return;
    }

    const conversationText = extractTextFromMessages(event.messages);
    if (conversationText.length < 100) {
      return;
    }

    try {
      const fs = await import("node:fs");
      const path = await import("node:path");

      // Resolve agent memory directory
      const agentDir = path.join(workspaceDir, "agents", agentId);
      const memoryDir = path.join(agentDir, "memory");

      if (!fs.existsSync(agentDir)) {
        logger.debug?.(`[念·萃] agent dir not found: ${agentDir}`);
        return;
      }

      // Ensure memory directory exists
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
      }

      // Call Haiku for extraction
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        logger.warn("[念·萃] ANTHROPIC_API_KEY not set, skipping extraction");
        return;
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 512,
          messages: [
            {
              role: "user",
              content: `${EXTRACTION_PROMPT}\n\n--- CONVERSATION ---\n${conversationText}`,
            },
          ],
        }),
      });

      if (!response.ok) {
        logger.warn(`[念·萃] Haiku API error: ${response.status}`);
        return;
      }

      const result = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      const extractedText = result.content?.[0]?.text?.trim();

      if (!extractedText || extractedText === "NONE") {
        logger.debug?.(`[念·萃] no facts extracted for ${agentId}`);
        return;
      }

      // Append to episodes.md
      const episodesPath = path.join(memoryDir, "episodes.md");
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 16).replace("T", " ");
      const dateHeader = now.toISOString().slice(0, 10);

      let entry = "";

      // Add date header if this is the first entry today
      const existingContent = fs.existsSync(episodesPath)
        ? fs.readFileSync(episodesPath, "utf-8")
        : "";

      if (!existingContent.includes(`## ${dateHeader}`)) {
        entry += `\n## ${dateHeader}\n`;
      }

      entry += `\n### ${timestamp}\n${extractedText}\n`;

      fs.appendFileSync(episodesPath, entry, "utf-8");

      logger.info(
        `[念·萃] extracted ${extractedText.split("\n").filter((l: string) => l.startsWith("- ")).length} facts for ${agentId}`,
      );
    } catch (err) {
      logger.warn(`[念·萃] extraction failed for ${agentId}: ${err}`);
    }
  });

  logger.info("[念·萃] memory extraction hook registered");
}
