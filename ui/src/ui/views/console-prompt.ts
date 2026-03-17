/**
 * System Prompt Inspector – visualizes the composition of the system prompt,
 * bootstrap injection files, skills list, and runtime metadata.
 */

import { html, nothing } from "lit";
import type {
  PromptSnapshot,
  PromptSection,
  PromptSectionKind,
  BootstrapFile,
  SkillRuntimeMeta,
} from "../types/console-types.ts";

export type ConsolePromptProps = {
  loading: boolean;
  error: string | null;
  snapshot: PromptSnapshot | null;
  expandedSections: Set<string>;
  onRefresh: () => void;
  onToggleSection: (sectionId: string) => void;
};

function sectionKindColor(kind: PromptSectionKind): string {
  switch (kind) {
    case "system-base":
      return "var(--info)";
    case "bootstrap":
      return "var(--accent-2)";
    case "claude-md":
      return "var(--accent)";
    case "agents-md":
      return "var(--accent)";
    case "skills":
      return "var(--ok)";
    case "tools-catalog":
      return "var(--warn)";
    case "runtime-metadata":
      return "#a78bfa";
    case "session-context":
      return "var(--accent-2)";
    case "custom":
      return "var(--muted)";
    default:
      return "var(--muted)";
  }
}

function sectionKindIcon(kind: PromptSectionKind): string {
  switch (kind) {
    case "system-base":
      return "\u2630";
    case "bootstrap":
      return "\u21E3";
    case "claude-md":
      return "\u2263";
    case "agents-md":
      return "\u2263";
    case "skills":
      return "\u26A1";
    case "tools-catalog":
      return "\u2699";
    case "runtime-metadata":
      return "\u2139";
    case "session-context":
      return "\u21C4";
    case "custom":
      return "\u270E";
    default:
      return "\u2022";
  }
}

function renderTokenBar(tokenCount: number, totalTokens: number): unknown {
  const pct = totalTokens > 0 ? Math.round((tokenCount / totalTokens) * 100) : 0;
  return html`
    <div class="prompt-token-bar">
      <div class="prompt-token-bar__fill" style="width: ${pct}%; background: var(--accent)"></div>
    </div>
    <span class="prompt-token-count">${tokenCount} tokens (${pct}%)</span>
  `;
}

function renderSection(
  section: PromptSection,
  totalTokens: number,
  expanded: boolean,
  onToggle: () => void,
): unknown {
  const color = sectionKindColor(section.kind);
  const icon = sectionKindIcon(section.kind);

  return html`
    <div class="prompt-section" @click=${onToggle} style="cursor: pointer;">
      <div class="prompt-section-header">
        <div class="prompt-section-header__left">
          <span class="prompt-section-icon" style="color: ${color}">${icon}</span>
          <span class="prompt-section-kind" style="color: ${color}">${section.kind}</span>
          <span class="prompt-section-label">${section.label}</span>
        </div>
        <div class="prompt-section-header__right">
          ${renderTokenBar(section.tokenCount, totalTokens)}
          <span class="prompt-section-toggle">${expanded ? "\u25BC" : "\u25B6"}</span>
        </div>
      </div>
      ${section.source ? html`<div class="prompt-section-source mono">${section.source}</div>` : nothing}
      ${
        expanded
          ? html`
              <div class="prompt-section-content">
                <pre class="code-block">${section.content}</pre>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

function renderBootstrapFiles(files: BootstrapFile[]): unknown {
  return html`
    <div class="prompt-bootstrap">
      <div class="card-subtitle">Bootstrap Injection Files</div>
      <div class="data-table-container" style="margin-top: 8px;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Exists</th>
              <th>Size</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            ${files.map(
              (file) => html`
                <tr>
                  <td><span class="mono">${file.path}</span></td>
                  <td>
                    <span class="data-table-badge ${file.exists ? "data-table-badge--direct" : "data-table-badge--unknown"}">
                      ${file.exists ? "yes" : "missing"}
                    </span>
                  </td>
                  <td>${file.sizeBytes > 0 ? `${file.sizeBytes} B` : "\u2014"}</td>
                  <td>${file.tokenCount > 0 ? file.tokenCount : "\u2014"}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSkillsMeta(skills: SkillRuntimeMeta[]): unknown {
  return html`
    <div class="prompt-skills-meta">
      <div class="card-subtitle">Skills Runtime Metadata</div>
      <div class="data-table-container" style="margin-top: 8px;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Enabled</th>
              <th>Source</th>
              <th>Trigger Pattern</th>
              <th>Token Budget</th>
            </tr>
          </thead>
          <tbody>
            ${skills.map(
              (skill) => html`
                <tr>
                  <td>${skill.name}</td>
                  <td><span class="mono">${skill.key}</span></td>
                  <td>
                    <span class="data-table-badge ${skill.enabled ? "data-table-badge--direct" : "data-table-badge--unknown"}">
                      ${skill.enabled ? "active" : "disabled"}
                    </span>
                  </td>
                  <td>${skill.source}</td>
                  <td><span class="mono" style="font-size: 12px;">${skill.triggerPattern ?? "\u2014"}</span></td>
                  <td>${skill.tokenBudget != null ? skill.tokenBudget : "\u2014"}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function renderConsolePrompt(props: ConsolePromptProps) {
  const snapshot = props.snapshot;

  return html`
    <div class="console-prompt">
      <section class="card">
        <div class="row" style="justify-content: space-between; margin-bottom: 16px;">
          <div>
            <div class="card-title">System Prompt Inspector</div>
            <div class="card-sub">
              ${
                snapshot
                  ? html`Agent: <strong>${snapshot.agentId}</strong>
                      \u00B7 ${snapshot.sections.length} sections
                      \u00B7 ${snapshot.totalTokens} total tokens`
                  : "Inspect how the system prompt is composed."
              }
            </div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading\u2026" : "Refresh"}
          </button>
        </div>

        ${
          props.error
            ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`
            : nothing
        }

        ${
          snapshot
            ? html`
                <!-- Token composition overview -->
                <div class="prompt-composition-bar">
                  ${snapshot.sections.map(
                    (section) => {
                      const pct = snapshot.totalTokens > 0 ? (section.tokenCount / snapshot.totalTokens) * 100 : 0;
                      return html`
                        <div
                          class="prompt-composition-segment"
                          style="width: ${pct}%; background: ${sectionKindColor(section.kind)}; min-width: ${pct > 0 ? "2px" : "0"}"
                          title="${section.label}: ${section.tokenCount} tokens (${Math.round(pct)}%)"
                        ></div>
                      `;
                    },
                  )}
                </div>
                <div class="prompt-composition-legend">
                  ${snapshot.sections.map(
                    (section) => html`
                      <span class="prompt-composition-legend-item">
                        <span class="prompt-composition-legend-dot" style="background: ${sectionKindColor(section.kind)}"></span>
                        ${section.label}
                      </span>
                    `,
                  )}
                </div>

                <!-- Section list -->
                <div class="prompt-sections">
                  ${snapshot.sections.map(
                    (section) =>
                      renderSection(
                        section,
                        snapshot.totalTokens,
                        props.expandedSections.has(section.id),
                        () => props.onToggleSection(section.id),
                      ),
                  )}
                </div>

                <!-- Bootstrap files -->
                ${renderBootstrapFiles(snapshot.bootstrapFiles)}

                <!-- Skills metadata -->
                ${renderSkillsMeta(snapshot.skillsMetadata)}
              `
            : nothing
        }
      </section>
    </div>
  `;
}
