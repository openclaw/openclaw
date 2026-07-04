/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalGatewayClient } from "./terminal-connection.ts";

vi.mock("ghostty-web", () => {
  class Terminal {
    cols = 100;
    rows = 30;
    viewportY = 0;

    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    write() {}
    focus() {}
    dispose() {}
  }

  class FitAddon {
    fit() {}
    observeResize() {}
    dispose() {}
  }

  return { init: vi.fn(async () => {}), Terminal, FitAddon };
});

import { OpenClawTerminalPanel } from "./terminal-panel.ts";

describe("OpenClawTerminalPanel", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("opens new sessions for the selected agent", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return {
          sessionId: "session-1",
          agentId: "ops",
          shell: "/bin/zsh",
          cwd: "/work/ops",
          confined: false,
        } as T;
      },
      addEventListener: () => () => {},
    };
    const panel = new OpenClawTerminalPanel();
    panel.client = client;
    panel.agentId = "ops";
    panel.available = true;
    document.body.append(panel);

    panel.toggle();

    await vi.waitFor(() => {
      expect(requests[0]).toEqual({
        method: "terminal.open",
        params: { agentId: "ops", cols: 100, rows: 30 },
      });
    });
  });
});
