import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";

export type OverviewLogTailProps = {
  lines: string[];
  redacted: boolean;
  onRefreshLogs: () => void;
};

export function renderOverviewLogTail(props: OverviewLogTailProps) {
  if (props.lines.length === 0) {
    return nothing;
  }

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
      <pre class="ov-log-tail-content ${props.redacted ? "redacted" : ""}">${
        props.redacted ? "[log hidden]" : props.lines.slice(-50).join("\n")
      }</pre>
    </details>
  `;
}
