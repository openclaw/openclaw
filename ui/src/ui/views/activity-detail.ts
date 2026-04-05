import { html, nothing } from "lit";
import type { ActivityNode } from "../activity/activity-types.ts";
import { icons } from "../icons.ts";

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

function renderField(label: string, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return nothing;
  }
  return html`
    <div class="activity-detail__field">
      <span class="activity-detail__field-label muted">${label}</span>
      <span class="activity-detail__field-value">${value}</span>
    </div>
  `;
}

function formatJsonPreview(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderMetadataBlock(metadata: Record<string, unknown>) {
  const entries = Object.entries(metadata).filter(
    ([k, v]) => v !== undefined && v !== null && k !== "args" && k !== "result",
  );
  if (entries.length === 0) {
    return nothing;
  }

  return html`
    <div class="activity-detail__section">
      <div class="activity-detail__section-title muted">Metadata</div>
      <pre class="activity-detail__json">
${JSON.stringify(Object.fromEntries(entries), null, 2)}</pre
      >
    </div>
  `;
}

export type ActivityDetailProps = {
  node: ActivityNode | null;
  onClose: () => void;
};

export function renderActivityDetail(props: ActivityDetailProps) {
  const { node, onClose } = props;
  if (!node) {
    return nothing;
  }

  return html`
    <div class="activity-detail">
      <div class="activity-detail__header">
        <span class="activity-detail__title">${node.label}</span>
        <button class="btn btn--subtle btn--sm" @click=${onClose}>${icons.x}</button>
      </div>

      <div class="activity-detail__body">
        <div class="activity-detail__section">
          <div class="activity-detail__section-title muted">Info</div>
          ${renderField("Kind", node.kind)} ${renderField("Status", node.status)}
          ${renderField("Started", formatTimestamp(node.startedAt))}
          ${renderField("Ended", node.endedAt ? formatTimestamp(node.endedAt) : null)}
          ${renderField("Duration", formatDuration(node.durationMs))}
          ${renderField("Depth", node.depth)} ${renderField("Run ID", node.runId)}
        </div>

        ${node.kind === "tool" && node.metadata.args
          ? html`
              <div class="activity-detail__section">
                <div class="activity-detail__section-title muted">Input</div>
                <pre class="activity-detail__json">${formatJsonPreview(node.metadata.args)}</pre>
              </div>
            `
          : nothing}
        ${node.kind === "tool" && node.metadata.result
          ? html`
              <div class="activity-detail__section">
                <div class="activity-detail__section-title muted">Output</div>
                <pre class="activity-detail__json">${formatJsonPreview(node.metadata.result)}</pre>
              </div>
            `
          : nothing}
        ${node.error
          ? html`
              <div class="activity-detail__section activity-detail__section--error">
                <div class="activity-detail__section-title muted">Error</div>
                <pre class="activity-detail__error">${node.error}</pre>
              </div>
            `
          : nothing}
        ${renderMetadataBlock(node.metadata)}
      </div>
    </div>
  `;
}
