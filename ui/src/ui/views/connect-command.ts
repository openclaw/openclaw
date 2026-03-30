import { html } from "lit";
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
      title="Copy command"
      aria-label=${`Copy command: ${command}`}
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
      ${renderCopyButton(command, "Copy command")}
    </div>
  `;
}
