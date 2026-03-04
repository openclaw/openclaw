/**
 * Loading skeleton components for OpenClaw Control UI
 * 
 * Provides skeleton screens for better perceived performance during:
 * - Config loading
 * - Channel status loading
 * - Session list loading
 * - Long operations
 */

import { html, nothing } from "lit";

/**
 * Generic skeleton block
 */
export function renderSkeletonBlock(opts: {
  width?: string;
  height?: string;
  className?: string;
}) {
  const width = opts.width || "100%";
  const height = opts.height || "1em";
  const className = opts.className || "";

  return html`
    <div
      class="skeleton ${className}"
      style="width: ${width}; height: ${height};"
      aria-hidden="true"
    ></div>
  `;
}

/**
 * Skeleton for form fields
 */
export function renderSkeletonFormField() {
  return html`
    <div class="field skeleton-field">
      ${renderSkeletonBlock({ width: "30%", height: "1em" })}
      ${renderSkeletonBlock({ width: "100%", height: "2.5em" })}
    </div>
  `;
}

/**
 * Skeleton for config form
 */
export function renderSkeletonConfigForm() {
  return html`
    <div class="skeleton-config-form">
      ${renderSkeletonBlock({ width: "40%", height: "1.5em", className: "mb-2" })}
      ${renderSkeletonFormField()} ${renderSkeletonFormField()} ${renderSkeletonFormField()}
      ${renderSkeletonFormField()}
      <div class="mt-3">
        ${renderSkeletonBlock({ width: "20%", height: "2em" })}
        ${renderSkeletonBlock({ width: "20%", height: "2em" })}
      </div>
    </div>
  `;
}

/**
 * Skeleton for channel status card
 */
export function renderSkeletonChannelCard() {
  return html`
    <div class="skeleton-channel-card">
      <div style="display: flex; gap: 12px; align-items: center;">
        ${renderSkeletonBlock({ width: "40px", height: "40px" })}
        <div style="flex: 1;">
          ${renderSkeletonBlock({ width: "60%", height: "1.2em" })}
          ${renderSkeletonBlock({ width: "40%", height: "0.9em" })}
        </div>
        ${renderSkeletonBlock({ width: "80px", height: "24px" })}
      </div>
    </div>
  `;
}

/**
 * Skeleton for session list
 */
export function renderSkeletonSessionList(count = 5) {
  return html`
    <div class="skeleton-session-list">
      ${Array.from({ length: count }, (_, i) => html`
        <div class="skeleton-session-item" key=${i}>
          <div style="display: flex; gap: 12px; align-items: center;">
            ${renderSkeletonBlock({ width: "32px", height: "32px" })}
            <div style="flex: 1;">
              ${renderSkeletonBlock({ width: "70%", height: "1em" })}
              ${renderSkeletonBlock({ width: "50%", height: "0.8em" })}
            </div>
            ${renderSkeletonBlock({ width: "60px", height: "0.9em" })}
          </div>
        </div>
      `)}
    </div>
  `;
}

/**
 * Skeleton for table rows
 */
export function renderSkeletonTableRow(columns: number) {
  return html`
    <tr class="skeleton-table-row">
      ${Array.from({ length: columns }, (_, i) => html`
        <td key=${i}>${renderSkeletonBlock({ width: "80%", height: "1em" })}</td>
      `)}
    </tr>
  `;
}

/**
 * Skeleton for cron job card
 */
export function renderSkeletonCronJobCard() {
  return html`
    <div class="skeleton-cron-job">
      <div style="display: flex; justify-content: space-between; align-items: start;">
        <div style="flex: 1;">
          ${renderSkeletonBlock({ width: "60%", height: "1.2em" })}
          ${renderSkeletonBlock({ width: "40%", height: "0.9em" })}
        </div>
        <div style="display: flex; gap: 8px;">
          ${renderSkeletonBlock({ width: "32px", height: "32px" })}
          ${renderSkeletonBlock({ width: "32px", height: "32px" })}
        </div>
      </div>
    </div>
  `;
}

/**
 * Progress bar for long operations
 */
export function renderProgressBar(opts: {
  label?: string;
  progress?: number;
  indeterminate?: boolean;
}) {
  const progress = opts.progress ?? 0;
  const indeterminate = opts.indeterminate ?? false;

  return html`
    <div class="progress-container">
      ${opts.label ? html`<div class="progress-label">${opts.label}</div>` : nothing}
      <div class="progress-bar" role="progressbar" aria-valuenow=${progress} aria-valuemin="0" aria-valuemax="100">
        <div
          class="progress-bar-fill ${indeterminate ? "progress-bar-fill--indeterminate" : ""}"
          style=${indeterminate ? "" : `width: ${progress}%`}
        ></div>
      </div>
    </div>
  `;
}

/**
 * Spinner for inline loading
 */
export function renderSpinner(opts?: { size?: string; label?: string }) {
  const size = opts?.size || "24px";

  return html`
    <div class="spinner-container">
      <svg
        class="spinner"
        viewBox="0 0 50 50"
        style="width: ${size}; height: ${size};"
        aria-label=${opts?.label || "Loading"}
      >
        <circle
          class="spinner-path"
          cx="25"
          cy="25"
          r="20"
          fill="none"
          stroke="currentColor"
          stroke-width="4"
        ></circle>
      </svg>
      ${opts?.label ? html`<span class="spinner-label">${opts.label}</span>` : nothing}
    </div>
  `;
}

/**
 * CSS styles for skeleton components (to be added to styles.css)
 */
export const SKELETON_STYLES = `
.skeleton {
  background: linear-gradient(
    90deg,
    var(--color-bg-secondary, #f0f0f0) 0%,
    var(--color-bg-tertiary, #e0e0e0) 50%,
    var(--color-bg-secondary, #f0f0f0) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
  border-radius: 4px;
}

@keyframes skeleton-pulse {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}

.skeleton-field {
  margin-bottom: 16px;
}

.skeleton-channel-card,
.skeleton-session-item,
.skeleton-cron-job {
  padding: 16px;
  border: 1px solid var(--color-border, #e0e0e0);
  border-radius: 8px;
  margin-bottom: 12px;
}

.progress-container {
  width: 100%;
  margin: 16px 0;
}

.progress-label {
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--color-text-secondary, #666);
}

.progress-bar {
  width: 100%;
  height: 8px;
  background-color: var(--color-bg-secondary, #f0f0f0);
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background-color: var(--color-accent, #6366f1);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-bar-fill--indeterminate {
  width: 30%;
  animation: progress-indeterminate 1.5s ease-in-out infinite;
}

@keyframes progress-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}

.spinner-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spinner {
  animation: spinner-rotate 2s linear infinite;
}

.spinner-path {
  stroke-dasharray: 90, 150;
  stroke-dashoffset: 0;
  stroke-linecap: round;
  animation: spinner-dash 1.5s ease-in-out infinite;
}

@keyframes spinner-rotate {
  100% {
    transform: rotate(360deg);
  }
}

@keyframes spinner-dash {
  0% {
    stroke-dasharray: 1, 150;
    stroke-dashoffset: 0;
  }
  50% {
    stroke-dasharray: 90, 150;
    stroke-dashoffset: -35;
  }
  100% {
    stroke-dasharray: 90, 150;
    stroke-dashoffset: -124;
  }
}

.spinner-label {
  font-size: 14px;
  color: var(--color-text-secondary, #666);
}

.mb-2 {
  margin-bottom: 8px;
}

.mt-3 {
  margin-top: 16px;
}
`;
