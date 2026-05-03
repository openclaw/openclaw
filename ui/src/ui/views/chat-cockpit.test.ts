/* @vitest-environment jsdom */

import { render, type TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import {
  renderChatCockpit,
  renderCockpitSessionHeader,
  renderCockpitApprovalsTray,
  renderCockpitToolTimeline,
  renderCockpitContextCost,
  renderCockpitModelSwitch,
  renderCockpitComposerPalette,
  renderCockpitObsLinks,
  renderCockpitRightPane,
  renderCockpitErrorBanners,
  type CockpitState,
  type CockpitCallbacks,
  type CockpitToolEntry,
  type CockpitErrorBanner,
} from "./chat-cockpit.ts";

function createCallbacks(): CockpitCallbacks {
  return {
    onNewSession: vi.fn(),
    onForkSession: vi.fn(),
    onExportSession: vi.fn(),
    onApprovalDecision: vi.fn(),
    onSummarize: vi.fn(),
    onDropTools: vi.fn(),
    onDismissError: vi.fn(),
    onRightPaneTabChange: vi.fn(),
    onToggleRightPane: vi.fn(),
    onComposerPaletteSelect: vi.fn(),
    onNavigateToLogs: vi.fn(),
    onNavigateToSessions: vi.fn(),
  };
}

function createState(overrides?: Partial<CockpitState>): CockpitState {
  return {
    session: {
      sessionKey: "test-session-abc123",
      startedAt: Date.now(),
      nodeId: "node-1",
      execPolicy: "ask",
    },
    approvals: [],
    toolTimeline: [],
    cost: {
      cumulativeCost: 0.05,
      inputTokens: 1200,
      outputTokens: 800,
      cacheHits: 50,
    },
    model: {
      modelId: "claude-opus-4-6",
      thinkingLevel: "medium",
    },
    errors: [],
    rightPaneTab: "node",
    rightPaneOpen: false,
    composerPaletteOpen: false,
    composerPaletteQuery: "",
    composerPaletteIndex: 0,
    slashCommands: [],
    nodes: [],
    memoryEntries: [],
    ...overrides,
  };
}

function renderToContainer(template: TemplateResult | typeof import("lit").nothing): HTMLElement {
  const container = document.createElement("div");
  render(template, container);
  return container;
}

describe("chat-cockpit", () => {
  describe("renderCockpitSessionHeader", () => {
    it("renders session ID, time, node, and policy", () => {
      const callbacks = createCallbacks();
      const session = {
        sessionKey: "my-session-key",
        startedAt: Date.now(),
        nodeId: "node-1",
        execPolicy: "ask",
      };
      const el = renderToContainer(renderCockpitSessionHeader(session, callbacks));
      expect(el.querySelector(".cockpit-session-header")).toBeTruthy();
      const sessionIdTag = el.querySelector(".cockpit-session-header__tag--id");
      expect(sessionIdTag?.textContent).toContain("my-session-k…");
      expect(sessionIdTag?.getAttribute("title")).toBe("my-session-key");
      expect(el.textContent).toContain("node-1");
      expect(el.textContent).toContain("ask");
    });

    it("renders action buttons", () => {
      const callbacks = createCallbacks();
      const session = { sessionKey: "s1", startedAt: null };
      const el = renderToContainer(renderCockpitSessionHeader(session, callbacks));
      const buttons = el.querySelectorAll(".cockpit-btn");
      expect(buttons.length).toBe(3);
      expect(buttons[0]?.textContent).toContain("New");
      expect(buttons[1]?.textContent).toContain("Fork");
      expect(buttons[2]?.textContent).toContain("Export");
    });

    it("calls onNewSession when New button clicked", () => {
      const callbacks = createCallbacks();
      const session = { sessionKey: "s1", startedAt: null };
      const el = renderToContainer(renderCockpitSessionHeader(session, callbacks));
      (el.querySelector(".cockpit-btn") as HTMLButtonElement)?.click();
      expect(callbacks.onNewSession).toHaveBeenCalled();
    });
  });

  describe("renderCockpitApprovalsTray", () => {
    it("returns nothing when no approvals", () => {
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitApprovalsTray([], callbacks, false));
      expect(el.querySelector(".cockpit-approvals-tray")).toBeNull();
    });

    it("renders approval cards", () => {
      const callbacks = createCallbacks();
      const approvals: ExecApprovalRequest[] = [
        {
          id: "a1",
          kind: "exec",
          request: { command: "rm -rf /tmp/test" },
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60000,
        },
      ];
      const el = renderToContainer(renderCockpitApprovalsTray(approvals, callbacks, false));
      expect(el.querySelector(".cockpit-approval-card")).toBeTruthy();
      expect(el.textContent).toContain("rm -rf /tmp/test");
    });

    it("calls onApprovalDecision with Allow", () => {
      const callbacks = createCallbacks();
      const approvals: ExecApprovalRequest[] = [
        {
          id: "a1",
          kind: "exec",
          request: { command: "echo hi" },
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60000,
        },
      ];
      const el = renderToContainer(renderCockpitApprovalsTray(approvals, callbacks, false));
      const allowBtn = el.querySelector(".cockpit-btn--primary") as HTMLButtonElement;
      allowBtn?.click();
      expect(callbacks.onApprovalDecision).toHaveBeenCalledWith("a1", "allow-once");
    });
  });

  describe("renderCockpitToolTimeline", () => {
    it("returns nothing when empty", () => {
      const el = renderToContainer(renderCockpitToolTimeline([]));
      expect(el.querySelector(".cockpit-tool-timeline")).toBeNull();
    });

    it("renders tool entries with status indicators", () => {
      const entries: CockpitToolEntry[] = [
        {
          id: "t1",
          name: "Bash",
          command: "ls -la",
          exitCode: 0,
          status: "success",
          startedAt: Date.now(),
        },
        {
          id: "t2",
          name: "Read",
          status: "running",
          startedAt: Date.now(),
        },
      ];
      const el = renderToContainer(renderCockpitToolTimeline(entries));
      expect(el.querySelectorAll(".cockpit-tool-entry").length).toBe(2);
      expect(el.querySelector(".cockpit-tool-entry__indicator--success")).toBeTruthy();
      expect(el.querySelector(".cockpit-tool-entry__indicator--running")).toBeTruthy();
      expect(el.textContent).toContain("exit 0");
    });
  });

  describe("renderCockpitContextCost", () => {
    it("renders token counts and cost", () => {
      const callbacks = createCallbacks();
      const cost = {
        cumulativeCost: 0.42,
        inputTokens: 5000,
        outputTokens: 3000,
        cacheHits: 100,
      };
      const el = renderToContainer(renderCockpitContextCost(cost, callbacks));
      expect(el.textContent).toContain("5,000");
      expect(el.textContent).toContain("3,000");
      expect(el.textContent).toContain("$0.42");
      expect(el.textContent).toContain("100");
    });

    it("hides cache when zero", () => {
      const callbacks = createCallbacks();
      const cost = {
        cumulativeCost: 0,
        inputTokens: 100,
        outputTokens: 50,
        cacheHits: 0,
      };
      const el = renderToContainer(renderCockpitContextCost(cost, callbacks));
      expect(el.textContent).not.toContain("cached");
    });

    it("calls onSummarize when button clicked", () => {
      const callbacks = createCallbacks();
      const cost = { cumulativeCost: 0, inputTokens: 0, outputTokens: 0, cacheHits: 0 };
      const el = renderToContainer(renderCockpitContextCost(cost, callbacks));
      const btns = el.querySelectorAll(".cockpit-btn");
      (btns[0] as HTMLButtonElement)?.click();
      expect(callbacks.onSummarize).toHaveBeenCalled();
    });
  });

  describe("renderCockpitModelSwitch", () => {
    it("returns nothing when no model", () => {
      const el = renderToContainer(
        renderCockpitModelSwitch({ modelId: null, thinkingLevel: null }),
      );
      expect(el.querySelector(".cockpit-model-switch")).toBeNull();
    });

    it("renders model and thinking level", () => {
      const el = renderToContainer(
        renderCockpitModelSwitch({ modelId: "claude-opus-4-6", thinkingLevel: "high" }),
      );
      expect(el.textContent).toContain("claude-opus-4-6");
      expect(el.textContent).toContain("thinking: high");
    });
  });

  describe("renderCockpitComposerPalette", () => {
    it("returns nothing when closed", () => {
      const el = renderToContainer(renderCockpitComposerPalette(false, "", 0, [], vi.fn()));
      expect(el.querySelector(".cockpit-composer-palette")).toBeNull();
    });

    it("renders filtered commands", () => {
      const commands = [
        { key: "help", name: "help", description: "Get help" },
        { key: "new", name: "new", description: "New session" },
        { key: "model", name: "model", description: "Switch model" },
      ];
      const el = renderToContainer(renderCockpitComposerPalette(true, "mod", 0, commands, vi.fn()));
      const items = el.querySelectorAll(".cockpit-composer-palette__item");
      expect(items.length).toBe(1);
      expect(items[0]?.textContent).toContain("/model");
    });

    it("calls onSelect when item clicked", () => {
      const onSelect = vi.fn();
      const commands = [{ key: "new", name: "new", description: "New session" }];
      const el = renderToContainer(renderCockpitComposerPalette(true, "", 0, commands, onSelect));
      (el.querySelector(".cockpit-composer-palette__item") as HTMLElement)?.click();
      expect(onSelect).toHaveBeenCalledWith("/new");
    });
  });

  describe("renderCockpitObsLinks", () => {
    it("renders Logs and Sessions links", () => {
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitObsLinks(callbacks, "sess-1"));
      const links = el.querySelectorAll(".cockpit-obs-link");
      expect(links.length).toBe(2);
      expect(links[0]?.textContent).toContain("Logs");
      expect(links[1]?.textContent).toContain("Sessions");
    });

    it("navigates to logs on click", () => {
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitObsLinks(callbacks, "sess-1"));
      (el.querySelector(".cockpit-obs-link") as HTMLElement)?.click();
      expect(callbacks.onNavigateToLogs).toHaveBeenCalled();
    });
  });

  describe("renderCockpitRightPane", () => {
    it("returns nothing when closed", () => {
      const state = createState({ rightPaneOpen: false });
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitRightPane(state, callbacks));
      expect(el.querySelector(".cockpit-right-pane")).toBeNull();
    });

    it("renders tabs when open", () => {
      const state = createState({ rightPaneOpen: true });
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitRightPane(state, callbacks));
      const tabs = el.querySelectorAll(".cockpit-right-pane__tab");
      expect(tabs.length).toBe(4);
    });

    it("shows approval badge count", () => {
      const state = createState({
        rightPaneOpen: true,
        approvals: [
          {
            id: "a1",
            kind: "exec",
            request: { command: "test" },
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60000,
          },
        ],
      });
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitRightPane(state, callbacks));
      expect(el.querySelector(".cockpit-right-pane__tab-badge")?.textContent?.trim()).toBe("1");
    });

    it("renders empty state for nodes tab", () => {
      const state = createState({ rightPaneOpen: true, rightPaneTab: "node", nodes: [] });
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitRightPane(state, callbacks));
      expect(el.textContent).toContain("No nodes connected");
    });

    it("renders nodes when available", () => {
      const state = createState({
        rightPaneOpen: true,
        rightPaneTab: "node",
        nodes: [{ id: "node-1" }, { id: "node-2" }],
      });
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitRightPane(state, callbacks));
      expect(el.textContent).toContain("node-1");
      expect(el.textContent).toContain("node-2");
    });

    it("renders memory entries", () => {
      const state = createState({
        rightPaneOpen: true,
        rightPaneTab: "memory",
        memoryEntries: ["Remember: user prefers dark mode"],
      });
      const callbacks = createCallbacks();
      const el = renderToContainer(renderCockpitRightPane(state, callbacks));
      expect(el.textContent).toContain("Remember: user prefers dark mode");
    });
  });

  describe("renderCockpitErrorBanners", () => {
    it("returns nothing when no errors", () => {
      const el = renderToContainer(renderCockpitErrorBanners([], vi.fn()));
      expect(el.querySelector(".cockpit-error-banner")).toBeNull();
    });

    it("renders error banners with dismiss", () => {
      const onDismiss = vi.fn();
      const errors: CockpitErrorBanner[] = [
        { id: "e1", message: "Tool failed", severity: "error", ts: Date.now() },
        {
          id: "e2",
          message: "Rate limited",
          detail: "retry in 30s",
          severity: "warning",
          ts: Date.now(),
        },
      ];
      const el = renderToContainer(renderCockpitErrorBanners(errors, onDismiss));
      const banners = el.querySelectorAll(".cockpit-error-banner");
      expect(banners.length).toBe(2);
      expect(banners[0]?.textContent).toContain("Tool failed");
      expect(banners[1]?.textContent).toContain("Rate limited");
      expect(banners[1]?.textContent).toContain("retry in 30s");
    });

    it("calls onDismiss when dismiss button clicked", () => {
      const onDismiss = vi.fn();
      const errors: CockpitErrorBanner[] = [
        { id: "e1", message: "Oops", severity: "error", ts: Date.now() },
      ];
      const el = renderToContainer(renderCockpitErrorBanners(errors, onDismiss));
      (el.querySelector(".cockpit-error-banner__dismiss") as HTMLButtonElement)?.click();
      expect(onDismiss).toHaveBeenCalledWith("e1");
    });
  });

  describe("renderChatCockpit (orchestrator)", () => {
    it("renders all cockpit sections", () => {
      const state = createState({
        toolTimeline: [
          { id: "t1", name: "Bash", status: "success", exitCode: 0, startedAt: Date.now() },
        ],
        errors: [{ id: "e1", message: "fail", severity: "error", ts: Date.now() }],
      });
      const callbacks = createCallbacks();
      const el = renderToContainer(renderChatCockpit(state, callbacks));

      // Session header
      expect(el.querySelector(".cockpit-session-header")).toBeTruthy();
      // Model switch
      expect(el.querySelector(".cockpit-model-switch")).toBeTruthy();
      // Tool timeline
      expect(el.querySelector(".cockpit-tool-timeline")).toBeTruthy();
      // Context/cost
      expect(el.querySelector(".cockpit-context-cost")).toBeTruthy();
      // Obs links
      expect(el.querySelector(".cockpit-obs-links")).toBeTruthy();
      // Error banner
      expect(el.querySelector(".cockpit-error-banner")).toBeTruthy();
    });
  });
});
