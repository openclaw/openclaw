import { diffChars, diffLines } from "diff";
import { html } from "lit";

// Word-level diff for raw JSON mode
export type DiffPart = {
  value: string;
  added?: boolean;
  removed?: boolean;
};

// Single line diff with word-level highlighting
export type SingleLineDiff = {
  type: "single";
  lineNumber: number;
  parts: DiffPart[];
};

// Multi-line diff - compact view showing changed lines
export type MultiLineDiff = {
  type: "multi";
  startLine: number;
  originalLines: string[];
  newLines: string[];
};

export type DiffLine = SingleLineDiff | MultiLineDiff;

export function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): Array<{ path: string; from: unknown; to: unknown }> {
  if (!original || !current) {
    return [];
  }
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];

  function compare(orig: unknown, curr: unknown, path: string) {
    if (orig === curr) {
      return;
    }
    if (typeof orig !== typeof curr) {
      changes.push({ path, from: orig, to: curr });
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    if (Array.isArray(orig) && Array.isArray(curr)) {
      if (JSON.stringify(orig) !== JSON.stringify(curr)) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], path ? `${path}.${key}` : key);
    }
  }

  compare(original, current, "");
  return changes;
}

export function truncateValue(value: unknown, maxLen = 40): string {
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + "...";
}

// Use diff library's line diff for smarter comparison
export function computeRawDiff(originalRaw: string, currentRaw: string): DiffLine[] {
  // Use diffLines for line-level comparison
  const diffResult = diffLines(originalRaw, currentRaw);
  const result: DiffLine[] = [];

  // Track original and current line indices
  let origIdx = 0;
  let currIdx = 0;

  let i = 0;
  while (i < diffResult.length) {
    const part = diffResult[i];

    // Check for consecutive removed -> added (same line modification)
    if (part.removed && i + 1 < diffResult.length && diffResult[i + 1].added) {
      // This is a line modification: removed part followed by added part
      // Split lines but remove empty last element if string ends with newline
      let removedLines = part.value.split("\n");
      if (part.value.endsWith("\n")) {
        removedLines = removedLines.slice(0, -1);
      }
      const addedPart = diffResult[i + 1];
      let addedLines = addedPart.value.split("\n");
      if (addedPart.value.endsWith("\n")) {
        addedLines = addedLines.slice(0, -1);
      }

      // Check if this is truly a line modification vs. an add/delete
      const isModification = removedLines.length === 1 && addedLines.length === 1;

      // Handle single-line modification (only when both lines are truly different)
      if (isModification) {
        // Use the original values with newlines preserved for accurate comparison
        const originalRemovedValue = part.value.endsWith("\n")
          ? removedLines[0] + "\n"
          : removedLines[0];
        const originalAddedValue = addedPart.value.endsWith("\n")
          ? addedLines[0] + "\n"
          : addedLines[0];

        // Use diffChars to compare the two versions of the same line
        const diffResult2 = diffChars(originalRemovedValue, originalAddedValue);
        result.push({
          type: "single",
          lineNumber: origIdx + 1,
          parts: diffResult2.map((p) => ({
            value: p.value,
            added: p.added,
            removed: p.removed,
          })),
        });
        origIdx += 1;
        currIdx += 1;
        i += 2; // Skip both parts
        continue;
      }

      // For cases where one is a substring of another, fall through to separate handling
      // This handles cases like adding a new line at the end (removed is prefix of added)
    }

    if (part.added) {
      // Lines added in current
      // Split lines but remove empty last element if string ends with newline
      let addedLines = part.value.split("\n");
      if (part.value.endsWith("\n")) {
        addedLines = addedLines.slice(0, -1);
      }
      if (addedLines.length >= 2) {
        // Multi-line addition
        result.push({
          type: "multi",
          startLine: currIdx + 1,
          originalLines: [],
          newLines: addedLines,
        });
      } else if (addedLines.length === 1) {
        // Single line addition - show with word diff against empty
        // Preserve newline information for accurate diff
        const originalAddedValue = part.value.endsWith("\n") ? addedLines[0] + "\n" : addedLines[0];
        const diffResult2 = diffChars("", originalAddedValue);
        result.push({
          type: "single",
          lineNumber: currIdx + 1,
          parts: diffResult2.map((p) => ({
            value: p.value,
            added: p.added,
            removed: p.removed,
          })),
        });
      }
      currIdx += addedLines.length;
    } else if (part.removed) {
      // Lines removed from original
      // Split lines but remove empty last element if string ends with newline
      let removedLines = part.value.split("\n");
      if (part.value.endsWith("\n")) {
        removedLines = removedLines.slice(0, -1);
      }
      if (removedLines.length >= 2) {
        // Multi-line removal
        result.push({
          type: "multi",
          startLine: origIdx + 1,
          originalLines: removedLines,
          newLines: [],
        });
      } else if (removedLines.length === 1) {
        // Single line removal - show with word diff against empty
        // Preserve newline information for accurate diff
        const originalRemovedValue = part.value.endsWith("\n")
          ? removedLines[0] + "\n"
          : removedLines[0];
        const diffResult2 = diffChars(originalRemovedValue, "");
        result.push({
          type: "single",
          lineNumber: origIdx + 1,
          parts: diffResult2.map((p) => ({
            value: p.value,
            added: p.added,
            removed: p.removed,
          })),
        });
      }
      origIdx += removedLines.length;
    } else {
      // Unchanged lines - skip
      // Split lines but remove empty last element if string ends with newline
      let unchangedLines = part.value.split("\n");
      if (part.value.endsWith("\n")) {
        unchangedLines = unchangedLines.slice(0, -1);
      }
      origIdx += unchangedLines.length;
      currIdx += unchangedLines.length;
    }
    i++;
  }

  return result;
}

export function renderDiffLine(diffLine: DiffLine) {
  if (diffLine.type === "multi") {
    // Compact multi-line diff: show all changed lines without side-by-side
    return html`
      <div class="config-raw-diff__multi-compact">
        <div class="config-raw-diff__multi-header">
          <span class="config-raw-diff__multi-badge">
            ${diffLine.originalLines.length}→${diffLine.newLines.length} lines
          </span>
        </div>
        <div class="config-raw-diff__multi-lines">
          ${diffLine.originalLines.map(
            (line, idx) => html`
              <div class="config-raw-diff__line config-raw-diff__line--removed">
                <span class="config-raw-diff__line-num">${diffLine.startLine + idx}</span>
                <span class="config-raw-diff__text">${line}</span>
              </div>
            `,
          )}
          ${diffLine.newLines.map(
            (line, idx) => html`
              <div class="config-raw-diff__line config-raw-diff__line--added">
                <span class="config-raw-diff__line-num">${diffLine.startLine + diffLine.originalLines.length + idx}</span>
                <span class="config-raw-diff__text">${line}</span>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  // Single line diff with word-level highlighting
  return html`
    <div class="config-raw-diff__line config-raw-diff__line--changed">
      <span class="config-raw-diff__line-num">${diffLine.lineNumber}</span>
      ${diffLine.parts.map((part) =>
        part.added
          ? html`<span class="config-raw-diff__char--added">${part.value}</span>`
          : part.removed
            ? html`<span class="config-raw-diff__char--removed">${part.value}</span>`
            : html`${part.value}`,
      )}
    </div>
  `;
}

export function renderRawDiff(originalRaw: string, currentRaw: string) {
  const diffLines = computeRawDiff(originalRaw, currentRaw);

  if (diffLines.length === 0) {
    return html`
      <div class="config-raw-diff config-raw-diff--empty">No changes detected</div>
    `;
  }

  // Calculate total changed lines
  const totalChangedLines = diffLines.reduce((sum, line) => {
    if (line.type === "multi") {
      return sum + line.originalLines.length + line.newLines.length;
    }
    return sum + 1;
  }, 0);

  return html`
    <div class="config-raw-diff">
      <div class="config-raw-diff__header">
        <span class="config-raw-diff__title">
          ${totalChangedLines} changed line${totalChangedLines !== 1 ? "s" : ""}
        </span>
        <div class="config-raw-diff__legend">
          <span class="config-raw-diff__legend-item">
            <span class="config-raw-diff__legend-color config-raw-diff__legend-color--line"></span>
            Changed line
          </span>
          <span class="config-raw-diff__legend-item">
            <span class="config-raw-diff__legend-color config-raw-diff__legend-color--char"></span>
            Changed chars
          </span>
        </div>
      </div>
      <div class="config-raw-diff__content">
        ${diffLines.map((line) => renderDiffLine(line))}
      </div>
    </div>
  `;
}
