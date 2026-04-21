import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { renderCopyButton } from "../chat/copy-as-markdown.ts";

async function copyCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    // Best effort only; the explicit copy button provides visible feedback.
  }
}

export function renderConnectCommand(command: string) {
  return html`
    <div
      class="login-gate__command"
      role="button"
      tabindex="0"
      title=${t("connectCommand.copyTitle")}
      aria-label=${t("connectCommand.copyAria", { command })}
      @click=${async (e: Event) => {
        if ((e.target as HTMLElement | null)?.closest(".chat-copy-btn")) {
          return;
        }
        await copyCommand(command);
      }}
      @keydown=${async (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") {
          return;
        }
        e.preventDefault();
        await copyCommand(command);
      }}
    >
      <code>${command}</code>
      ${renderCopyButton(command, t("connectCommand.copyTitle"))}
    </div>
  `;
}
