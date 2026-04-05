import { html, nothing } from "lit";
import type { ActivityController } from "../activity/activity-controller.ts";
import { flattenTimeline } from "../activity/activity-tree.ts";
import type { ActivityNode } from "../activity/activity-types.ts";
import { icons } from "../icons.ts";
import { renderActivityDetail } from "./activity-detail.ts";
import { renderActivityFilters } from "./activity-filters.ts";
import { renderActivityMetrics } from "./activity-metrics.ts";
import { renderActivityTimeline } from "./activity-timeline.ts";
import { renderActivityTreeNode } from "./activity-tree-node.ts";

export type ActivityViewProps = {
  connected: boolean;
  controller: ActivityController;
};

function renderEmptyState() {
  return html`
    <div class="activity-empty">
      <span class="activity-empty__icon">${icons.activity}</span>
      <p class="activity-empty__text muted">
        No agent activity. Send a message to see the execution tree here.
      </p>
    </div>
  `;
}

export function renderActivity(props: ActivityViewProps) {
  if (!props.connected) {
    return html`<div class="activity-empty muted">
      Connect to the gateway to see agent activity.
    </div>`;
  }

  const { controller } = props;
  const metrics = controller.metrics;
  const displayTree = controller.filteredTree;
  const timeline = flattenTimeline(displayTree);
  const selectedNode = controller.selectedNode;

  const rootNodes = displayTree.rootNodes
    .map((id) => displayTree.nodeById.get(id))
    .filter((n): n is ActivityNode => n !== undefined);

  return html`
    <div class="activity-view">
      ${renderActivityMetrics({
        metrics,
        toolCallsHistory: controller.toolCallsHistory,
        errorsHistory: controller.errorsHistory,
        activeRunsHistory: controller.activeRunsHistory,
      })}
      ${renderActivityFilters({
        filters: {
          kinds: controller.filters.kinds,
          search: controller.filters.search,
          timeRangeMs: controller.filters.timeRangeMs,
        },
        onSearchChange: (s) => controller.setSearch(s),
        onKindToggle: (k) => controller.toggleKind(k),
        onTimeRangeChange: (ms) => controller.setTimeRange(ms),
      })}
      ${controller.tree.totalNodes === 0
        ? renderEmptyState()
        : displayTree.totalNodes === 0
          ? html`<div class="activity-empty muted">No events match filters.</div>`
          : html`
              <div class="activity-panels ${selectedNode ? "activity-panels--with-detail" : ""}">
                <div class="activity-panel activity-panel--tree">
                  <div class="activity-panel__header muted">Execution Tree</div>
                  <div class="activity-panel__body">
                    ${rootNodes.map((node) =>
                      renderActivityTreeNode(node, displayTree, 0, (id) =>
                        controller.selectNode(id),
                      ),
                    )}
                  </div>
                </div>
                <div class="activity-panel activity-panel--timeline">
                  <div class="activity-panel__header muted">Timeline</div>
                  <div class="activity-panel__body">
                    ${renderActivityTimeline({ entries: timeline })}
                  </div>
                </div>
                ${selectedNode
                  ? html`
                      <div class="activity-panel activity-panel--detail">
                        ${renderActivityDetail({
                          node: selectedNode,
                          onClose: () => controller.selectNode(null),
                        })}
                      </div>
                    `
                  : nothing}
              </div>
            `}
    </div>
  `;
}
