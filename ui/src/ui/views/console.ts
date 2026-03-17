/**
 * Main Console view – hub for the control console panels.
 * Provides navigation between trace, prompt inspector, and security views.
 */

import { html, nothing } from "lit";
import type { ConsoleState } from "../controllers/console.ts";
import type { TraceNode } from "../types/console-types.ts";
import { renderConsoleTrace } from "./console-trace.ts";
import { renderConsolePrompt } from "./console-prompt.ts";
import { renderConsoleSecurity } from "./console-security.ts";
import { renderSessionDetail } from "./console-session-detail.ts";

export type ConsolePanel = "trace" | "prompt" | "security";

export type ConsoleViewProps = {
  panel: ConsolePanel;
  state: ConsoleState;
  onPanelChange: (panel: ConsolePanel) => void;
  onRefreshTrace: () => void;
  onSelectRun: (runId: string) => void;
  onSubagentClick: (node: TraceNode) => void;
  onSubagentClose: () => void;
  onRefreshPrompt: () => void;
  onTogglePromptSection: (sectionId: string) => void;
  onRefreshSecurity: () => void;
  onSecurityTabChange: (tab: "tools" | "skills" | "plugins" | "hooks") => void;
  onSessionDetailClose: () => void;
  onSessionDetailSelectRun: (runId: string) => void;
};

const PANELS: Array<{ key: ConsolePanel; label: string; icon: string }> = [
  { key: "trace", label: "Run Trace", icon: "\u26A1" },
  { key: "prompt", label: "Prompt Inspector", icon: "\u2630" },
  { key: "security", label: "Security Policy", icon: "\uD83D\uDEE1" },
];

export function renderConsole(props: ConsoleViewProps) {
  return html`
    <div class="console-view">
      <!-- Panel switcher -->
      <div class="console-panel-tabs">
        ${PANELS.map(
          (p) => html`
            <button
              class="console-panel-tab ${props.panel === p.key ? "console-panel-tab--active" : ""}"
              @click=${() => props.onPanelChange(p.key)}
            >
              <span>${p.icon}</span>
              ${p.label}
            </button>
          `,
        )}
      </div>

      <!-- Active panel -->
      ${
        props.panel === "trace"
          ? renderConsoleTrace({
              loading: props.state.traceLoading,
              error: props.state.traceError,
              runList: props.state.traceRunList,
              selectedRunId: props.state.traceSelectedRunId,
              activeRun: props.state.traceActiveRun,
              subagentDetail: props.state.traceSubagentDetail,
              onSelectRun: props.onSelectRun,
              onRefresh: props.onRefreshTrace,
              onSubagentClick: props.onSubagentClick,
              onSubagentClose: props.onSubagentClose,
            })
          : nothing
      }

      ${
        props.panel === "prompt"
          ? renderConsolePrompt({
              loading: props.state.promptLoading,
              error: props.state.promptError,
              snapshot: props.state.promptSnapshot,
              expandedSections: props.state.promptExpandedSections,
              onRefresh: props.onRefreshPrompt,
              onToggleSection: props.onTogglePromptSection,
            })
          : nothing
      }

      ${
        props.panel === "security"
          ? renderConsoleSecurity({
              loading: props.state.securityLoading,
              error: props.state.securityError,
              snapshot: props.state.securitySnapshot,
              activeTab: props.state.securityActiveTab,
              onTabChange: props.onSecurityTabChange,
              onRefresh: props.onRefreshSecurity,
            })
          : nothing
      }

      <!-- Session detail overlay (when viewing a session) -->
      ${
        props.state.sessionDetail
          ? renderSessionDetail({
              loading: props.state.sessionDetailLoading,
              error: props.state.sessionDetailError,
              detail: props.state.sessionDetail,
              onClose: props.onSessionDetailClose,
              onSelectRun: props.onSessionDetailSelectRun,
            })
          : nothing
      }
    </div>
  `;
}
