import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

/** Strip ANSI escape codes (SGR, OSC-8) for readable log display. */
function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex -- stripping ANSI escape sequences requires matching ESC */
  return text.replace(/\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

export type OverviewLogTailProps = {
  lines: string[];
  redacted: boolean;
  onRefreshLogs: () => void;
};

export function renderOverviewLogTail(props: OverviewLogTailProps) {
  if (props.lines.length === 0) {
    return nothing;
  }

  const displayLines = props.redacted
    ? "[log hidden]"
    : props.lines
        .slice(-50)
        .map((line) => stripAnsi(line))
        .join("\n");

  return html`
    <details class="card ov-log-tail">
      <summary class="ov-expandable-toggle">
        <span class="nav-item__icon">${icons.scrollText}</span>
        ${t("overview.logTail.title")}
        <span class="ov-count-badge">${props.lines.length}</span>
        <span
          class="ov-log-refresh"
          @click=${(e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            props.onRefreshLogs();
          }}
        >${icons.loader}</span>
      </summary>
      <pre class="ov-log-tail-content ${props.redacted ? "redacted" : ""}">${displayLines}</pre>
    </details>
  `;
}
