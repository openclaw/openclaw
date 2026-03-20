/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { renderExecApprovalPrompt } from "./exec-approval.ts";
import { renderGatewayUrlConfirmation } from "./gateway-url-confirmation.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  const now = Date.now();
  return {
    execApprovalQueue: [
      {
        id: "req-1",
        createdAtMs: now - 1_000,
        expiresAtMs: now + 60_000,
        request: {
          command:
            "python - <<'PY'\nprint('very long command body')\nprint('still going')\nprint('done')\nPY",
          host: "gateway.local",
          agentId: "agent:main",
          sessionKey: "main",
          cwd: "/workspace",
          resolvedPath: "/usr/bin/python",
          security: "allowlist",
          ask: "on-miss",
        },
      },
    ],
    execApprovalBusy: false,
    execApprovalError: "Approval failed",
    pendingGatewayUrl: "https://example.invalid/ws",
    handleExecApprovalDecision: vi.fn(),
    handleGatewayUrlConfirm: vi.fn(),
    handleGatewayUrlCancel: vi.fn(),
    ...overrides,
  } as unknown as AppViewState;
}

describe("exec approval modal", () => {
  it("renders scrollable content separately from the action row", () => {
    const state = createState();
    const container = document.createElement("div");

    render(renderExecApprovalPrompt(state), container);

    const overlay = container.querySelector(".exec-approval-overlay");
    const card = container.querySelector(".exec-approval-card");
    const body = container.querySelector(".exec-approval-body");
    const actions = container.querySelector(".exec-approval-actions");

    expect(overlay?.getAttribute("aria-modal")).toBe("true");
    expect(card).not.toBeNull();
    expect(body).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(card?.children[1]).toBe(body);
    expect(card?.lastElementChild).toBe(actions);
    expect(body?.querySelector(".exec-approval-command")?.textContent).toContain(
      "very long command",
    );
    expect(body?.querySelector(".exec-approval-error")?.textContent).toContain("Approval failed");
  });

  it("uses the same scrollable body structure for gateway URL confirmation", () => {
    const state = createState({ execApprovalQueue: [] });
    const container = document.createElement("div");

    render(renderGatewayUrlConfirmation(state), container);

    const card = container.querySelector(".exec-approval-card");
    const body = container.querySelector(".exec-approval-body");
    const actions = container.querySelector(".exec-approval-actions");

    expect(body).not.toBeNull();
    expect(card?.children[1]).toBe(body);
    expect(card?.lastElementChild).toBe(actions);
    expect(body?.querySelector(".exec-approval-command")?.textContent).toContain(
      "https://example.invalid/ws",
    );
  });
});
