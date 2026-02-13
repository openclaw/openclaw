import { html, nothing, type TemplateResult } from "lit";
import type { AgentHQDiffResult, AgentHQHistoryResult } from "../types.ts";
import { renderIcon } from "../icons.ts";

export type AgentHQDiffProps = {
  diff: AgentHQDiffResult | null;
  loading: boolean;
  history: AgentHQHistoryResult | null;
  selectedCommit: string | null;
  selectedFile: string | null;
  onSelectCommit: (sha: string, fileName: string) => void;
};

export function renderAgentHQDiff(props: AgentHQDiffProps): TemplateResult {
  if (!props.history || props.history.entries.length === 0) {
    return html`
      <div class="agenthq-empty">
        ${renderIcon("diff", "agenthq-empty-icon")}
        <div class="agenthq-empty-title">No Changes to Compare</div>
        <div class="agenthq-empty-desc">
          Select a commit from the timeline or visual view to see the detailed changes.
        </div>
      </div>
    `;
  }

  return html`
    <div class="agenthq-diff">
      ${renderCommitSelector(props)} ${props.loading ? renderLoading() : renderDiffContent(props)}
    </div>
  `;
}

function renderCommitSelector(props: AgentHQDiffProps): TemplateResult {
  if (!props.history) {
    return html``;
  }

  const allFiles = new Set<string>();
  for (const entry of props.history.entries) {
    for (const file of entry.files) {
      allFiles.add(file.name);
    }
  }

  return html`
    <div class="agenthq-diff-header">
      <div class="agenthq-diff-file">
        <select
          class="agenthq-summary-select"
          .value=${props.selectedCommit ?? ""}
          @change=${(e: Event) => {
            const sha = (e.target as HTMLSelectElement).value;
            if (sha && props.selectedFile) {
              props.onSelectCommit(sha, props.selectedFile);
            } else if (sha && props.history) {
              const entry = props.history.entries.find((e) => e.sha === sha);
              if (entry?.files[0]) {
                props.onSelectCommit(sha, entry.files[0].name);
              }
            }
          }}
        >
          <option value="">Select a commit...</option>
          ${props.history.entries.map(
            (entry) => html`
              <option value="${entry.sha}" ?selected=${entry.sha === props.selectedCommit}>
                ${entry.shortSha} - ${entry.message.slice(0, 40)}${
                  entry.message.length > 40 ? "..." : ""
                }
              </option>
            `,
          )}
        </select>

        <select
          class="agenthq-summary-select"
          .value=${props.selectedFile ?? ""}
          @change=${(e: Event) => {
            const fileName = (e.target as HTMLSelectElement).value;
            if (fileName && props.selectedCommit) {
              props.onSelectCommit(props.selectedCommit, fileName);
            }
          }}
          ?disabled=${!props.selectedCommit}
        >
          <option value="">Select a file...</option>
          ${
            props.selectedCommit
              ? props.history.entries
                  .find((e) => e.sha === props.selectedCommit)
                  ?.files.map(
                    (file) => html`
                    <option value="${file.name}" ?selected=${file.name === props.selectedFile}>
                      ${file.name}
                    </option>
                  `,
                  )
              : Array.from(allFiles).map((name) => html` <option value="${name}">${name}</option> `)
          }
        </select>
      </div>

      ${
        props.diff
          ? html`
            <div class="agenthq-diff-sha">${props.diff.sha.slice(0, 7)}</div>
          `
          : nothing
      }
    </div>
  `;
}

function renderLoading(): TemplateResult {
  return html`
    <div class="agenthq-loading">
      <div class="agenthq-loading-spinner"></div>
      <div class="agenthq-loading-text">Loading diff...</div>
    </div>
  `;
}

function renderDiffContent(props: AgentHQDiffProps): TemplateResult {
  if (!props.diff) {
    return html`
      <div class="agenthq-diff-empty">
        ${renderIcon("diff", "agenthq-diff-empty-icon")}
        <div>Select a commit and file to view changes</div>
      </div>
    `;
  }

  if (props.diff.hunks.length === 0) {
    return html`
      <div class="agenthq-diff-empty">
        ${renderIcon("check", "agenthq-diff-empty-icon")}
        <div>No text changes in this file</div>
      </div>
    `;
  }

  return html`
    <div class="agenthq-diff-content">
      ${props.diff.hunks.map((hunk) => renderHunk(hunk))}
    </div>
  `;
}

function renderHunk(hunk: AgentHQDiffResult["hunks"][0]): TemplateResult {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  return html`
    <div class="agenthq-diff-hunk">
      <div class="agenthq-diff-hunk-header">
        @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@
      </div>
      ${hunk.lines.map((line) => {
        let lineNum = "";
        if (line.type === "context") {
          lineNum = `${oldLine++} ${newLine++}`;
        } else if (line.type === "remove") {
          lineNum = `${oldLine++}    `;
        } else if (line.type === "add") {
          lineNum = `    ${newLine++}`;
        }

        return html`
          <div class="agenthq-diff-line ${line.type}">
            <span class="agenthq-diff-line-number">${lineNum}</span>
            <span class="agenthq-diff-line-content"
              >${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.content}</span
            >
          </div>
        `;
      })}
    </div>
  `;
}
