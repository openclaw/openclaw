// Control UI tests cover chat flow behavior.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
const contextBrowsers = new WeakMap<BrowserContext, Browser>();
const openBrowserContexts = new Set<BrowserContext>();

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

async function waitForRequests(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length >= count) {
      return requests;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
}

async function chatThreadDistanceFromBottom(page: Page): Promise<number> {
  return page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    return Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight);
  });
}

async function waitForChatScrollIdle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as
            | (Element & {
                chatIsProgrammaticScroll?: boolean;
                chatScrollFrame?: number | null;
                chatScrollTimeout?: number | null;
              })
            | null;
          return Boolean(
            app &&
            app.chatScrollFrame == null &&
            app.chatScrollTimeout == null &&
            !app.chatIsProgrammaticScroll,
          );
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function scrollChatThreadToTop(page: Page): Promise<void> {
  await page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

async function newBrowserContext(options: Parameters<Browser["newContext"]>[0]) {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext(options);
    contextBrowsers.set(context, browser);
    openBrowserContexts.add(context);
    return context;
  } catch (error) {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  const browser = contextBrowsers.get(context);
  openBrowserContexts.delete(context);
  contextBrowsers.delete(context);
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

async function closeOpenBrowserContexts(): Promise<void> {
  await Promise.all([...openBrowserContexts].map((context) => closeBrowserContext(context)));
}

async function visibleChatBubbleTexts(page: Page): Promise<string[]> {
  return page.locator(".chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    const viewport = thread.getBoundingClientRect();
    return Array.from(thread.querySelectorAll(".chat-bubble"))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.width > 0 &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom
        );
      })
      .map((candidate) => candidate.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}

async function controlUiEventPayloads(
  page: Page,
  event: string,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((eventName) => {
    const app = document.querySelector("openclaw-app") as
      | (Element & { eventLogBuffer?: unknown[] })
      | null;
    return (app?.eventLogBuffer ?? [])
      .filter((entry): entry is { event: string; payload: Record<string, unknown> } => {
        const candidate = entry as { event?: unknown; payload?: unknown };
        return (
          candidate.event === eventName &&
          Boolean(candidate.payload && typeof candidate.payload === "object")
        );
      })
      .map((entry) => entry.payload);
  }, event);
}

async function waitForControlUiChatSendPhases(
  page: Page,
  runId: string,
  phases: string[],
): Promise<void> {
  await page.waitForFunction(
    ({ expectedPhases, expectedRunId }) => {
      const app = document.querySelector("openclaw-app") as
        | (Element & { eventLogBuffer?: unknown[] })
        | null;
      const observedPhases = new Set(
        (app?.eventLogBuffer ?? []).flatMap((entry) => {
          const candidate = entry as {
            event?: unknown;
            payload?: { phase?: unknown; runId?: unknown };
          };
          return candidate.event === "control-ui.chat.send" &&
            candidate.payload?.runId === expectedRunId &&
            typeof candidate.payload.phase === "string"
            ? [candidate.payload.phase]
            : [];
        }),
      );
      return expectedPhases.every((phase) => observedPhases.has(phase));
    },
    { expectedPhases: phases, expectedRunId: runId },
  );
}

function chatSessionListResponse() {
  return {
    count: 2,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions: [
      {
        key: "agent:main:session-a",
        kind: "direct",
        label: "Session A",
        updatedAt: 2,
      },
      {
        key: "agent:main:session-b",
        kind: "direct",
        label: "Session B",
        updatedAt: 1,
      },
    ],
    ts: Date.now(),
  };
}

describeControlUiE2e("Control UI mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await closeOpenBrowserContexts();
    await server?.close();
  });

  afterEach(async () => {
    await closeOpenBrowserContexts();
  });

  it("sends a chat turn through the GUI and renders the final Gateway event", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Ready for an end-to-end GUI check.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Ready for an end-to-end GUI check.").waitFor({ timeout: 10_000 });

      const prompt = "verify the control UI e2e harness";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params.sessionKey).toBe("main");
      expect(params.message).toBe(prompt);
      expect(params.deliver).toBe(false);

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await gateway.emitChatFinal({ runId, text: "Harness verified." });

      await page.getByText("Harness verified.").waitFor({ timeout: 10_000 });

      const spacedPairCommand = "/ pair qr";
      await page.locator(".agent-chat__composer-combobox textarea").fill(spacedPairCommand);
      await page.getByRole("button", { name: "Send message" }).click();

      const commandRequests = await waitForRequests(gateway, "chat.send", 2);
      const commandParams = requireRecord(commandRequests[1]?.params);
      expect(commandParams.message).toBe(spacedPairCommand);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps the composer clear when a stale native input replay arrives after send", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Ready for stale replay check.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Ready for stale replay check.").waitFor({ timeout: 10_000 });

      const prompt = "submitted message";
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");
      expect(await composer.inputValue()).toBe("");

      const afterReplay = await composer.evaluate((element, submitted) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.value = submitted;
        textarea.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: submitted,
            inputType: "insertText",
          }),
        );
        return textarea.value;
      }, prompt);

      expect(afterReplay).toBe("");
      expect(await composer.inputValue()).toBe("");

      await composer.pressSequentially(prompt);
      expect(await composer.inputValue()).toBe(prompt);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("copies a code block over a non-secure context via the execCommand fallback", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    // Simulate a plain-HTTP (non-secure) deployment: navigator.clipboard is
    // undefined there, so the Clipboard API path throws. Capture the legacy
    // execCommand copy the fallback should use instead.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec = [];
      document.execCommand = ((command: string) => {
        if (command !== "copy") {
          return false;
        }
        // execCommand("copy") copies the active selection; the fallback selects
        // its off-screen scratch textarea, so the focused element holds the text.
        const active = document.activeElement as HTMLTextAreaElement | null;
        (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec.push(
          active?.value ?? "",
        );
        return true;
      }) as typeof document.execCommand;
    });
    const code = "const hello = 1;";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: `\`\`\`js\n${code}\n\`\`\``, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const copyButton = page.locator(".code-block-copy").first();
      await copyButton.waitFor({ timeout: 10_000 });
      await copyButton.click();

      await expect
        .poll(() => copyButton.evaluate((el) => el.classList.contains("copied")), {
          timeout: 10_000,
        })
        .toBe(true);
      const copied = await page.evaluate(
        () => (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec,
      );
      expect(copied).toContain(code);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("starts the workspace files panel collapsed and toggles it open", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "artifacts.list": {
          artifacts: [
            {
              download: { mode: "bytes" },
              id: "artifact-1",
              mimeType: "image/png",
              sizeBytes: 128,
              title: "preview.png",
              type: "image",
            },
          ],
        },
        "sessions.files.list": {
          browser: {
            entries: [
              {
                kind: "directory",
                name: "src",
                path: "src",
                sessionKind: "modified",
              },
              {
                kind: "file",
                name: "package.json",
                path: "package.json",
                size: 4096,
              },
            ],
            path: "",
          },
          files: [
            {
              kind: "modified",
              missing: false,
              name: "AGENTS.md",
              path: "/workspace/AGENTS.md",
              size: 2048,
            },
          ],
          root: "/workspace",
          sessionKey: "main",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByRole("button", { name: "Expand session workspace" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
      expect(await page.locator(".chat-workspace-rail__file").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__collapsed-icon svg").count()).toBe(1);

      await page.getByRole("button", { name: "Expand session workspace" }).click();
      await page.getByRole("button", { name: "Collapse session workspace" }).waitFor({
        timeout: 10_000,
      });
      await page.getByText("AGENTS.md").waitFor({ timeout: 10_000 });
      await page.getByText("preview.png").waitFor({ timeout: 10_000 });
      await page.getByText("Project files").waitFor({ timeout: 10_000 });
      await page.locator(".chat-workspace-rail__file-name", { hasText: "package.json" }).waitFor({
        timeout: 10_000,
      });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);
      expect(await gateway.getRequests("artifacts.list")).toHaveLength(1);

      await page.getByRole("button", { name: "Collapse session workspace" }).click();
      await page.getByRole("button", { name: "Expand session workspace" }).waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".chat-workspace-rail__file").count()).toBe(0);
      expect(await page.locator(".chat-workspace-rail__collapsed-icon svg").count()).toBe(1);

      await page.getByRole("button", { name: "Expand session workspace" }).click();
      await page.getByRole("button", { name: "Collapse session workspace" }).waitFor({
        timeout: 10_000,
      });
      await page.getByText("AGENTS.md").waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("sessions.files.list")).toHaveLength(1);

      await page.setViewportSize({ height: 900, width: 1000 });
      expect(await page.locator(".chat-workspace-rail").isHidden()).toBe(true);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("renders stable markdown during a streaming chat turn and finalizes the tail", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      const prompt = "stream markdown through the GUI";
      await gateway.deferNext("chat.send");
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const streamingText = "## Streaming heading\n\nworking **tail";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });
      await page.locator(".markdown-plain-text-fallback").getByText("working **tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback strong").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await page.waitForFunction(() => {
        const app = document.querySelector("openclaw-app") as
          | (Element & { chatSending?: unknown })
          | null;
        return app?.chatSending === false;
      });
      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });

      await gateway.emitChatFinal({
        runId,
        text: "## Streaming heading\n\nworking **tail**",
      });

      await page.locator(".chat-thread strong").getByText("tail").waitFor({ timeout: 10_000 });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps chat usable while sessions are still loading", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.list"],
      historyMessages: [
        {
          content: [{ text: "History renders before sessions finish.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      await page.getByText("History renders before sessions finish.").waitFor({ timeout: 10_000 });
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      await page.getByRole("button", { name: "Chat session" }).click();
      const sessionsList = await gateway.waitForRequest("sessions.list");
      expect(requireRecord(sessionsList.params)).toMatchObject({
        includeGlobal: true,
        includeUnknown: true,
        limit: 50,
      });

      await composer.fill("draft while sessions load");
      expect(await composer.inputValue()).toBe("draft while sessions load");
      await composer.fill("");

      await gateway.resolveDeferred("sessions.list");
      await page.getByRole("option", { name: /Main/ }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("sends the first chat turn while agents startup loading is still pending", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: "ops",
      deferredMethods: ["chat.startup"],
      historyMessages: [],
      sessionKey: "global",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      expect(await gateway.getRequests("agents.list")).toHaveLength(0);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const prompt = "send before agents list completes";
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .waitFor({ state: "visible", timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      expect(params.message).toBe(prompt);
      expect(params.sessionKey).toBe("global");
      expect(params.agentId).toBe("ops");

      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await waitForControlUiChatSendPhases(page, runId, ["ack"]);
      await gateway.emitGatewayEvent("chat.send_timing", {
        phase: "agent-run-started",
        runId,
        agentId: "ops",
        sessionKey: "global",
        ackToPhaseMs: 11,
        receivedToPhaseMs: 20,
        dispatchStartedToPhaseMs: 7,
        agentRunId: "agent-run-e2e",
      });
      await waitForControlUiChatSendPhases(page, runId, ["server-agent-run-started"]);
      await gateway.emitGatewayEvent("chat.send_timing", {
        phase: "first-assistant-event",
        runId,
        agentId: "ops",
        sessionKey: "global",
        ackToPhaseMs: 31,
        receivedToPhaseMs: 40,
        dispatchStartedToPhaseMs: 27,
      });
      await waitForControlUiChatSendPhases(page, runId, ["server-first-assistant-event"]);
      await gateway.emitGatewayEvent("chat", {
        deltaText: "First token visible.",
        message: {
          content: [{ text: "First token visible.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        agentId: "ops",
        sessionKey: "global",
        state: "delta",
      });
      await page.getByText("First token visible.").waitFor({ timeout: 10_000 });
      await waitForControlUiChatSendPhases(page, runId, [
        "pending-visible",
        "request-start",
        "ack",
        "server-agent-run-started",
        "server-first-assistant-event",
        "first-assistant-visible",
      ]);
      const sendTimingEvents = (await controlUiEventPayloads(page, "control-ui.chat.send")).filter(
        (payload) => payload.runId === runId,
      );
      const sendTimingByPhase = new Map(
        sendTimingEvents.map((payload) => [payload.phase, payload]),
      );
      expect(sendTimingEvents.map((payload) => payload.phase)).toEqual(
        expect.arrayContaining([
          "pending-visible",
          "request-start",
          "ack",
          "server-first-assistant-event",
          "first-assistant-visible",
        ]),
      );
      const ackTiming = sendTimingByPhase.get("ack");
      expect(ackTiming).toMatchObject({
        ackStatus: "started",
        runId,
        sendState: "sending",
        sessionKey: "global",
      });
      expect(ackTiming?.requestDurationMs).toEqual(expect.any(Number));
      expect(sendTimingByPhase.get("server-agent-run-started")).toMatchObject({
        agentRunId: "agent-run-e2e",
        agentId: "ops",
        runId,
        serverAckToPhaseMs: 11,
        serverDispatchStartedToPhaseMs: 7,
        serverPhase: "agent-run-started",
        serverReceivedToPhaseMs: 20,
        sessionKey: "global",
      });
      expect(sendTimingByPhase.get("server-first-assistant-event")).toMatchObject({
        agentId: "ops",
        runId,
        serverAckToPhaseMs: 31,
        serverDispatchStartedToPhaseMs: 27,
        serverPhase: "first-assistant-event",
        serverReceivedToPhaseMs: 40,
        sessionKey: "global",
      });
      const firstVisibleTiming = sendTimingByPhase.get("first-assistant-visible");
      expect(firstVisibleTiming).toMatchObject({
        ackStatus: "started",
        eventState: "delta",
        runId,
        sendState: "sending",
        sessionKey: "global",
      });
      expect(firstVisibleTiming?.ackToFirstAssistantEventMs).toEqual(expect.any(Number));
      expect(firstVisibleTiming?.firstAssistantPaintMs).toEqual(expect.any(Number));
      expect(firstVisibleTiming?.requestToFirstAssistantEventMs).toEqual(expect.any(Number));
      await gateway.resolveDeferred("chat.startup", {
        agentsList: {
          agents: [{ id: "ops", name: "OpenClaw" }],
          defaultId: "ops",
          mainKey: "main",
          scope: "agent",
        },
        messages: [],
        metadata: {
          models: [],
        },
        sessionId: "control-ui-e2e-session",
        thinkingLevel: null,
      });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await page.getByText("First token visible.").waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
      expect(await gateway.getRequests("commands.list")).toHaveLength(0);
      await gateway.emitChatFinal({ runId, text: "History race stayed visible." });
      await page.getByText("History race stayed visible.").waitFor({ timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill("/");
      await gateway.waitForRequest("commands.list");
      expect(await gateway.getRequests("agents.list")).toHaveLength(0);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps streamed text visible when a chat error terminates the turn", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      const prompt = "stream before terminal error";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const partialText = "Partial answer before gateway error.";
      await gateway.emitGatewayEvent("chat", {
        deltaText: partialText,
        message: {
          content: [{ text: partialText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await page.getByText(partialText).waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("chat", {
        errorMessage: "gateway disconnected",
        runId,
        sessionKey: "main",
        state: "error",
      });

      await page.getByText(partialText).waitFor({ timeout: 10_000 });
      await page.getByText("Error: gateway disconnected").waitFor({ timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps a delayed chat.send ACK visible as pending until the ACK resolves", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "hold this until the ack arrives";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-queue").getByText("Sending").waitFor({ timeout: 10_000 });
      await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });

      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("scrolls a delayed pending send into view before the ACK resolves", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `History message ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("History message 49").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeGreaterThan(200);

      await gateway.deferNext("chat.send");

      const prompt = `pending send should scroll before ack\n${"visible now\n".repeat(6)}`;
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-thread").getByText("pending send should scroll").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("shows persisted user messages after opening History and scrolling mixed history", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const currentSessionMessages = [
      {
        content: [{ text: "Current session placeholder", type: "text" }],
        role: "assistant",
        timestamp: baseTs - 1,
      },
    ];
    const historyMessages = Array.from({ length: 70 }, (_, index) => ({
      content: [
        {
          text: `${index % 2 === 0 ? "User history question" : "Assistant history answer"} ${index}\n${"history detail line\n".repeat(4)}`,
          type: index % 2 === 0 ? "input_text" : "output_text",
        },
      ],
      role: index % 2 === 0 ? "user" : "assistant",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, {
      historyMessages: currentSessionMessages,
      methodResponses: {
        "chat.history": {
          cases: [
            {
              match: { sessionKey: "agent:main:session-b" },
              response: {
                messages: historyMessages,
                sessionId: "control-ui-e2e-history-session-b",
                thinkingLevel: null,
              },
            },
            {
              match: { sessionKey: "agent:main:session-a" },
              response: {
                messages: currentSessionMessages,
                sessionId: "control-ui-e2e-history-session-a",
                thinkingLevel: null,
              },
            },
          ],
        },
        "sessions.list": chatSessionListResponse(),
      },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Current session placeholder").waitFor({ timeout: 10_000 });

      await page.getByRole("button", { name: "Chat session" }).click();
      await page.getByRole("option", { name: /Session B/ }).click();
      const historyRequest = await gateway.waitForRequest("chat.history");
      expect(requireRecord(historyRequest.params)).toMatchObject({
        sessionKey: "agent:main:session-b",
      });
      await page.locator(".chat-thread").getByText("User history question 68").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-thread").getByText("Assistant history answer 69").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 68")) &&
              texts.some((text) => text.includes("Assistant history answer 69"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);

      await waitForChatScrollIdle(page);
      await scrollChatThreadToTop(page);
      await page.locator(".chat-thread").getByText("User history question 10").waitFor({
        timeout: 10_000,
      });
      await scrollChatThreadToTop(page);
      await page.locator(".chat-thread").getByText("User history question 0").waitFor({
        timeout: 10_000,
      });
      await scrollChatThreadToTop(page);
      await expect
        .poll(
          async () => {
            const texts = await visibleChatBubbleTexts(page);
            return (
              texts.some((text) => text.includes("User history question 0")) &&
              texts.some((text) => text.includes("Assistant history answer 1"))
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps rejected pre-ACK sends visible and restores the draft", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "policy should not eat this";
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await gateway.waitForRequest("chat.send");

      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "send blocked by session policy",
      });

      await page.locator(".chat-queue").getByText("Failed").waitFor({ timeout: 10_000 });
      await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
      expect(await composer.inputValue()).toBe(prompt);
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("retries an ACK-lost send after reconnect with the same idempotency key", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "retry with the same key";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const firstRequest = await gateway.waitForRequest("chat.send");
      const firstParams = requireRecord(firstRequest.params);
      const runId = requireString(firstParams.idempotencyKey, "first idempotency key");

      await gateway.closeLatest(1006, "lost ack");

      const sends = await waitForRequests(gateway, "chat.send", 2);
      const secondParams = requireRecord(sends[1]?.params);
      expect(secondParams.idempotencyKey).toBe(runId);
      expect(secondParams.message).toBe(prompt);
      await page.locator(".chat-queue").waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("keeps a session model override selected after switching away and back", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const main = page.getByRole("main");
      const openModelSelect = async () => {
        const trigger = main.locator('[data-chat-model-select="true"]').first();
        await trigger.waitFor({ state: "visible", timeout: 10_000 });
        return trigger;
      };
      const selectModel = async (value: string) => {
        await main.locator('[data-chat-model-select="true"]').click();
        const option = main.locator(`[data-chat-model-option="${value}"]`);
        await option.waitFor({ state: "visible", timeout: 10_000 });
        await option.click();
      };

      let modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await selectModel("bedrock/claude-opus-4.5");
      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        key: "agent:main:session-a",
        model: "bedrock/claude-opus-4.5",
      });
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
        "bedrock/claude-opus-4.5",
      );

      await page
        .locator('a.sidebar-recent-session[data-session-key="agent:main:session-b"]')
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session B").waitFor({
        timeout: 10_000,
      });
      modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe("");

      await page
        .locator('a.sidebar-recent-session[data-session-key="agent:main:session-a"]')
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session A").waitFor({
        timeout: 10_000,
      });

      modelSelect = await openModelSelect();
      expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
        "bedrock/claude-opus-4.5",
      );
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("shows a pending send while a model override save is still pending", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const main = page.getByRole("main");
      await main.locator('[data-chat-model-select="true"]').click();
      await main.locator('[data-chat-model-option="bedrock/claude-opus-4.5"]').click();
      await gateway.waitForRequest("sessions.patch");

      const prompt = "send while the model save is pending";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      await page.locator(".chat-queue").getByText("Waiting for model").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.patch", {});
      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      expect(params.message).toBe(prompt);
      expect(params.sessionKey).toBe("agent:main:session-a");
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("refreshes history after a tool-call window disconnects and reconnects", async () => {
    const context = await newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat`);

      const prompt = "use a tool then reconnect";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          args: { query: "status" },
          name: "status",
          phase: "start",
          toolCallId: "tool-1",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });
      await gateway.setHistoryMessages([
        {
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        {
          content: [{ text: "Recovered from refreshed history.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ]);

      await gateway.closeLatest(1006, "lost during tool call");

      await page.getByText("Recovered from refreshed history.").waitFor({ timeout: 15_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
    } finally {
      await closeBrowserContext(context);
    }
  });
});
