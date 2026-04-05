import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
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

function parseJsonSafe(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function renderJsonHighlighted(value: unknown): ReturnType<typeof html> {
  const parsed = parseJsonSafe(value);
  if (typeof parsed === "string") {
    return html`<pre class="activity-detail__json">${parsed}</pre>`;
  }
  try {
    const json = JSON.stringify(parsed, null, 2);
    const highlighted = json.replace(
      /("(?:[^"\\]|\\.)*")\s*:|("(?:[^"\\]|\\.)*")|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (match, key, str, bool, num) => {
        if (key) {
          return `<span class="json-key">${escapeHtml(key)}</span>:`;
        }
        if (str) {
          return `<span class="json-string">${escapeHtml(str)}</span>`;
        }
        if (bool) {
          return `<span class="json-bool">${bool}</span>`;
        }
        if (num) {
          return `<span class="json-number">${num}</span>`;
        }
        return match;
      },
    );
    return html`<pre class="activity-detail__json">${unsafeHTML(highlighted)}</pre>`;
  } catch {
    return html`<pre class="activity-detail__json">${String(value)}</pre>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMetadataBlock(metadata: Record<string, unknown>) {
  const entries = Object.entries(metadata).filter(
    ([k, v]) =>
      v !== undefined &&
      v !== null &&
      ![
        "args",
        "result",
        "outcome",
        "reason",
        "task",
        "_sessionKey",
        "childSessionKey",
        "parentSessionKey",
      ].includes(k),
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

        ${node.kind === "tool"
          ? html`
              <div class="activity-detail__section">
                <div class="activity-detail__section-title muted">Input</div>
                ${node.metadata.args
                  ? renderJsonHighlighted(node.metadata.args)
                  : html`<span class="muted">No input data</span>`}
              </div>
              <div class="activity-detail__section">
                <div class="activity-detail__section-title muted">Output</div>
                ${node.metadata.result
                  ? renderJsonHighlighted(node.metadata.result)
                  : html`<span class="muted"
                      >${node.status === "running" ? "Waiting for result…" : "No output data"}</span
                    >`}
              </div>
            `
          : nothing}
        ${node.kind === "subagent" && node.metadata.outcome
          ? html`
              <div class="activity-detail__section">
                <div class="activity-detail__section-title muted">Outcome</div>
                ${renderField(
                  "Status",
                  typeof node.metadata.outcome === "string"
                    ? node.metadata.outcome
                    : JSON.stringify(node.metadata.outcome),
                )}
                ${renderField(
                  "Reason",
                  typeof node.metadata.reason === "string" ? node.metadata.reason : null,
                )}
              </div>
            `
          : nothing}
        ${node.kind === "subagent" && node.metadata.task
          ? html`
              <div class="activity-detail__section">
                <div class="activity-detail__section-title muted">Task</div>
                <pre class="activity-detail__json">
${typeof node.metadata.task === "string"
                    ? node.metadata.task
                    : JSON.stringify(node.metadata.task)}</pre
                >
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
