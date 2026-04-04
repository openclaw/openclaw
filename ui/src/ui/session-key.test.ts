import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.ts";

const CONTROL_UI_SESSION_KEY_CONSUMERS = [
  "app.ts",
  "app-chat.ts",
  "app-render.ts",
  "app-render.helpers.ts",
  "chat/slash-command-executor.ts",
  "controllers/agents.ts",
] as const;

const FORBIDDEN_SESSION_KEY_IMPORT_RE =
  /src\/(?:routing\/session-key|sessions\/session-key-utils)\.js/;
const FORBIDDEN_BROWSER_RUNTIME_RE =
  /\b(?:contract-surfaces|createJiti|discoverOpenClawPlugins|loadPluginManifestRegistry)\b/;

function readUiSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("ui session-key helpers", () => {
  it("parses canonical agent-scoped session keys", () => {
    expect(parseAgentSessionKey("AGENT:Ops:Discord:Direct:User-42")).toEqual({
      agentId: "ops",
      rest: "discord:direct:user-42",
    });
  });

  it("normalizes agent ids into the browser-safe canonical form", () => {
    expect(normalizeAgentId("  Ops Team/Primary  ")).toBe("ops-team-primary");
    expect(normalizeAgentId("")).toBe(DEFAULT_AGENT_ID);
  });

  it("builds agent main session keys with the default main key", () => {
    expect(buildAgentMainSessionKey({ agentId: "Ops Team" })).toBe("agent:ops-team:main");
    expect(buildAgentMainSessionKey({ agentId: "main", mainKey: DEFAULT_MAIN_KEY })).toBe(
      "agent:main:main",
    );
  });

  it("resolves the default agent id for malformed or missing keys", () => {
    expect(resolveAgentIdFromSessionKey("main")).toBe(DEFAULT_AGENT_ID);
    expect(resolveAgentIdFromSessionKey(undefined)).toBe(DEFAULT_AGENT_ID);
  });

  it("detects nested subagent session keys", () => {
    expect(isSubagentSessionKey("subagent:run-1")).toBe(true);
    expect(isSubagentSessionKey("agent:ops:subagent:run-1")).toBe(true);
    expect(isSubagentSessionKey("agent:ops:main")).toBe(false);
  });
});

describe("ui session-key import guardrails", () => {
  it("keeps the browser helper free of server-side session key dependencies", () => {
    const source = readUiSource("./session-key.ts");

    expect(source).not.toMatch(FORBIDDEN_SESSION_KEY_IMPORT_RE);
    expect(source).not.toMatch(FORBIDDEN_BROWSER_RUNTIME_RE);
  });

  it("keeps control ui entry points off the server-side session key chain", () => {
    for (const relativePath of CONTROL_UI_SESSION_KEY_CONSUMERS) {
      const source = readUiSource(`./${relativePath}`);
      expect(source, relativePath).not.toMatch(FORBIDDEN_SESSION_KEY_IMPORT_RE);
    }
  });
});
