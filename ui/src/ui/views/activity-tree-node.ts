import { html, nothing } from "lit";
import type { ActivityNode, ActivityTree } from "../activity/activity-types.ts";
import { icons } from "../icons.ts";

function statusIndicator(status: string, isError: boolean) {
  if (isError || status === "error") {
    return html`<span class="activity-status activity-status--error">✗</span>`;
  }
  if (status === "running") {
    return html`<span class="activity-status activity-status--running"></span>`;
  }
  if (status === "completed") {
    return html`<span class="activity-status activity-status--done">✓</span>`;
  }
  return html`<span class="activity-status activity-status--pending">○</span>`;
}

function kindIcon(kind: string) {
  switch (kind) {
    case "tool":
      return icons.wrench;
    case "thinking":
      return icons.brain;
    case "subagent":
      return icons.folder;
    default:
      return icons.zap;
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderActivityTreeNode(
  node: ActivityNode,
  tree: ActivityTree,
  depth = 0,
  onSelect?: (nodeId: string) => void,
): ReturnType<typeof html> {
  const children = node.children
    .map((id) => tree.nodeById.get(id))
    .filter((n): n is ActivityNode => n !== undefined);

  const handleClick = () => onSelect?.(node.id);

  return html`
    <div class="activity-node" style="padding-left: ${depth * 20}px">
      <div class="activity-node__row" @click=${handleClick} role="button" tabindex="0">
        ${statusIndicator(node.status, node.isError)}
        <span class="activity-node__icon nav-item__icon">${kindIcon(node.kind)}</span>
        <span class="activity-node__label">${node.label}</span>
        ${node.durationMs !== null
          ? html`<span class="activity-node__duration muted"
              >${formatDuration(node.durationMs)}</span
            >`
          : nothing}
        ${node.error
          ? html`<span class="activity-node__error muted">${node.error.slice(0, 80)}</span>`
          : nothing}
      </div>
      ${children.map((child) => renderActivityTreeNode(child, tree, depth + 1, onSelect))}
    </div>
  `;
}
