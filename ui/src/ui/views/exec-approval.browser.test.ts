import { html, render } from "lit";
import { expect, test } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { renderExecApprovalPrompt } from "./exec-approval.ts";

const root = document.createElement("div");
document.body.append(root);

test("renders command explanation highlights in Chromium approval modal", async () => {
  await i18n.setLocale("en");
  render(
    renderExecApprovalPrompt({
      execApprovalQueue: [
        {
          id: "approval-browser-1",
          kind: "exec",
          request: {
            command: 'ls | grep "stuff" | python -c \'print("hi")\'',
            host: "gateway",
            security: "allowlist",
            ask: "always",
            commandExplanationLines: [
              "Risks:",
              "• python -c can run arbitrary code on your computer.",
            ],
            commandExplanationHighlights: [
              { startIndex: 0, endIndex: 2, kind: "command", severity: "info" },
              { startIndex: 20, endIndex: 29, kind: "risk", severity: "danger" },
            ],
          },
          createdAtMs: Date.now() - 1_000,
          expiresAtMs: Date.now() + 60_000,
        },
      ],
      execApprovalBusy: false,
      execApprovalError: null,
      handleExecApprovalDecision: async () => undefined,
    } as unknown as AppViewState),
    root,
  );

  const infoHighlight = root.querySelector(".exec-approval-command-highlight.command.info");
  const dangerHighlight = root.querySelector(".exec-approval-command-highlight.risk.danger");

  expect(infoHighlight?.textContent).toBe("ls");
  expect(dangerHighlight?.textContent).toBe("python -c");
  expect(root.querySelector(".exec-approval-explanation")?.textContent).toContain(
    "python -c can run arbitrary code on your computer.",
  );

  render(html``, root);
});
