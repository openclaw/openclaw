export const usageStylesString = `
  .usage-page-header {
    margin: 4px 0 12px;
  }
  .usage-page-title {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin-bottom: 4px;
  }
  .usage-page-subtitle {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 12px;
  }
  /* ===== FILTERS & HEADER ===== */
  .usage-filters-inline {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .usage-filters-inline select {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
  }
  .usage-filters-inline input[type="date"] {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
  }
  .usage-filters-inline input[type="text"] {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    min-width: 180px;
  }
  .usage-filters-inline .btn-sm {
    padding: 6px 12px;
    font-size: 14px;
  }
  .usage-refresh-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: rgba(255, 77, 77, 0.1);
    border-radius: 4px;
    font-size: 12px;
    color: #ff4d4d;
  }
  .usage-refresh-indicator::before {
    content: "";
    width: 10px;
    height: 10px;
    border: 2px solid #ff4d4d;
    border-top-color: transparent;
    border-radius: 50%;
    animation: usage-spin 0.6s linear infinite;
  }
  @keyframes usage-spin {
    to { transform: rotate(360deg); }
  }
  .active-filters {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .filter-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 12px;
    background: var(--accent-subtle);
    border: 1px solid var(--accent);
    border-radius: 16px;
    font-size: 12px;
  }
  .filter-chip-label {
    color: var(--accent);
    font-weight: 500;
  }
  .filter-chip-remove {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    padding: 2px 4px;
    font-size: 14px;
    line-height: 1;
    opacity: 0.7;
    transition: opacity 0.15s;
  }
  .filter-chip-remove:hover {
    opacity: 1;
  }
  .filter-clear-btn {
    padding: 4px 10px !important;
    font-size: 12px !important;
    line-height: 1 !important;
    margin-left: 8px;
  }
  .usage-query-bar {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) auto;
    gap: 10px;
    align-items: center;
    /* Keep the dropdown filter row from visually touching the query row. */
    margin-bottom: 10px;
  }
  .usage-query-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
    justify-self: end;
  }
  .usage-query-actions .btn {
    height: 34px;
    padding: 0 14px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 13px;
    line-height: 1;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text);
    box-shadow: none;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .usage-query-actions .btn:hover {
    background: var(--bg);
    border-color: var(--border-strong);
  }
  .usage-action-btn {
    height: 34px;
    padding: 0 14px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 13px;
    line-height: 1;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text);
    box-shadow: none;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .usage-action-btn:hover {
    background: var(--bg);
    border-color: var(--border-strong);
  }
  .usage-primary-btn {
    background: #ff4d4d;
    color: #fff;
    border-color: #ff4d4d;
    box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.12);
  }
  .btn.usage-primary-btn {
    background: #ff4d4d !important;
    border-color: #ff4d4d !important;
    color: #fff !important;
  }
  .usage-primary-btn:hover {
    background: #e64545;
    border-color: #e64545;
  }
  .btn.usage-primary-btn:hover {
    background: #e64545 !important;
    border-color: #e64545 !important;
  }
  .usage-primary-btn:disabled {
    background: rgba(255, 77, 77, 0.18);
    border-color: rgba(255, 77, 77, 0.3);
    color: #ff4d4d;
    box-shadow: none;
    cursor: default;
    opacity: 1;
  }
  .usage-primary-btn[disabled] {
    background: rgba(255, 77, 77, 0.18) !important;
    border-color: rgba(255, 77, 77, 0.3) !important;
    color: #ff4d4d !important;
    opacity: 1 !important;
  }
  .usage-secondary-btn {
    background: var(--bg-secondary);
    color: var(--text);
    border-color: var(--border);
  }
  .usage-query-input {
    width: 100%;
    min-width: 220px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
  }
  .usage-query-suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .usage-query-suggestion {
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 11px;
    color: var(--text);
    cursor: pointer;
    transition: background 0.15s;
  }
  .usage-query-suggestion:hover {
    background: var(--bg-hover);
  }
  .usage-filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-top: 14px;
  }
  details.usage-filter-select {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px 10px;
    background: var(--bg);
    font-size: 12px;
    min-width: 140px;
  }
  details.usage-filter-select summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-weight: 500;
  }
  details.usage-filter-select summary::-webkit-details-marker {
    display: none;
  }
  .usage-filter-badge {
    font-size: 11px;
    color: var(--text-muted);
  }
  .usage-filter-popover {
    position: absolute;
    left: 0;
    top: calc(100% + 6px);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.08);
    min-width: 220px;
    z-index: 20;
  }
  .usage-filter-actions {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  .usage-filter-actions button {
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 11px;
  }
  .usage-filter-options {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 200px;
    overflow: auto;
  }
  .usage-filter-option {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
  }
  .usage-query-hint {
    font-size: 11px;
    color: var(--text-muted);
  }
  .usage-query-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .usage-query-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 11px;
  }
  .usage-query-chip button {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  .usage-header {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--bg);
  }
  .usage-header.pinned {
    position: sticky;
    top: 12px;
    z-index: 6;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.06);
  }
  .usage-pin-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 11px;
    color: var(--text);
    cursor: pointer;
  }
  .usage-pin-btn.active {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
  }
  .usage-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .usage-header-title {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .usage-header-metrics {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .usage-metric-badge {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: transparent;
    font-size: 11px;
    color: var(--text-muted);
  }
  .usage-metric-badge strong {
    font-size: 12px;
    color: var(--text);
  }
  .usage-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .usage-controls .active-filters {
    flex: 1 1 100%;
  }
  .usage-controls input[type="date"] {
    min-width: 140px;
  }
  .usage-presets {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .usage-presets .btn {
    padding: 4px 8px;
    font-size: 11px;
  }
  .usage-quick-filters {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .usage-select {
    min-width: 120px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 12px;
  }
  .usage-export-menu summary {
    cursor: pointer;
    font-weight: 500;
    color: var(--text);
    list-style: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .usage-export-menu summary::-webkit-details-marker {
    display: none;
  }
  .usage-export-menu {
    position: relative;
  }
  .usage-export-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    font-size: 12px;
  }
  .usage-export-popover {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.08);
    min-width: 160px;
    z-index: 10;
  }
  .usage-export-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .usage-export-item {
    text-align: left;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 12px;
  }
  .usage-summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-top: 12px;
  }
  .usage-summary-card {
    padding: 12px;
    border-radius: 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
  }
  .usage-mosaic {
    margin-top: 16px;
    padding: 16px;
  }
  .usage-mosaic-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .usage-mosaic-title {
    font-weight: 600;
  }
  .usage-mosaic-sub {
    font-size: 12px;
    color: var(--text-muted);
  }
  .usage-mosaic-grid {
    display: grid;
    grid-template-columns: minmax(200px, 1fr) minmax(260px, 2fr);
    gap: 16px;
    align-items: start;
  }
  .usage-mosaic-section {
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px;
  }
  .usage-mosaic-section-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .usage-mosaic-total {
    font-size: 20px;
    font-weight: 700;
  }
  .usage-daypart-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
    gap: 8px;
  }
  .usage-daypart-cell {
    border-radius: 8px;
    padding: 10px;
    color: var(--text);
    background: rgba(255, 77, 77, 0.08);
    border: 1px solid rgba(255, 77, 77, 0.2);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .usage-daypart-label {
    font-size: 12px;
    font-weight: 600;
  }
  .usage-daypart-value {
    font-size: 14px;
  }
  .usage-hour-grid {
    display: grid;
    grid-template-columns: repeat(24, minmax(6px, 1fr));
    gap: 4px;
  }
  .usage-hour-cell {
    height: 28px;
    border-radius: 6px;
    background: rgba(255, 77, 77, 0.1);
    border: 1px solid rgba(255, 77, 77, 0.2);
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .usage-hour-cell.selected {
    border-color: rgba(255, 77, 77, 0.8);
    box-shadow: 0 0 0 2px rgba(255, 77, 77, 0.2);
  }
  .usage-hour-labels {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 6px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .usage-hour-legend {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .usage-hour-legend span {
    display: inline-block;
    width: 14px;
    height: 10px;
    border-radius: 4px;
    background: rgba(255, 77, 77, 0.15);
    border: 1px solid rgba(255, 77, 77, 0.2);
  }
  .usage-calendar-labels {
    display: grid;
    grid-template-columns: repeat(7, minmax(10px, 1fr));
    gap: 6px;
    font-size: 10px;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .usage-calendar {
    display: grid;
    grid-template-columns: repeat(7, minmax(10px, 1fr));
    gap: 6px;
  }
  .usage-calendar-cell {
    height: 18px;
    border-radius: 4px;
    border: 1px solid rgba(255, 77, 77, 0.2);
    background: rgba(255, 77, 77, 0.08);
  }
  .usage-calendar-cell.empty {
    background: transparent;
    border-color: transparent;
  }
  .usage-summary-title {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 6px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .usage-info {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-left: 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg);
    font-size: 10px;
    color: var(--text-muted);
    cursor: help;
  }
  .usage-summary-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-strong);
  }
  .usage-summary-value.good {
    color: #1f8f4e;
  }
  .usage-summary-value.warn {
    color: #c57a00;
  }
  .usage-summary-value.bad {
    color: #c9372c;
  }
  .usage-summary-hint {
    font-size: 10px;
    color: var(--text-muted);
    cursor: help;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 6px;
    line-height: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .usage-summary-sub {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .usage-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .usage-list-item {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    color: var(--text);
    align-items: flex-start;
  }
  .usage-list-value {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    text-align: right;
  }
  .usage-list-sub {
    font-size: 11px;
    color: var(--text-muted);
  }
  .usage-list-item.button {
    border: none;
    background: transparent;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .usage-list-item.button:hover {
    color: var(--text-strong);
  }
  .usage-list-item .muted {
    font-size: 11px;
  }
  .usage-error-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .usage-error-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    align-items: center;
    font-size: 12px;
  }
  .usage-error-date {
    font-weight: 600;
  }
  .usage-error-rate {
    font-variant-numeric: tabular-nums;
  }
  .usage-error-sub {
    grid-column: 1 / -1;
    font-size: 11px;
    color: var(--text-muted);
  }
  .usage-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .usage-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 11px;
    background: var(--bg);
    color: var(--text);
  }
  .usage-meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
  }
  .usage-meta-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }
  .usage-meta-item span {
    color: var(--text-muted);
    font-size: 11px;
  }
  .usage-insights-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    margin-top: 12px;
  }
  .usage-insight-card {
    padding: 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
  }
  .usage-insight-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 10px;
  }
  .usage-insight-subtitle {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 6px;
  }
  /* ===== CHART TOGGLE ===== */
  .chart-toggle {
    display: flex;
    background: var(--bg);
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .chart-toggle .toggle-btn {
    padding: 6px 14px;
    font-size: 13px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.15s;
  }
  .chart-toggle .toggle-btn:hover {
    color: var(--text);
  }
  .chart-toggle .toggle-btn.active {
    background: #ff4d4d;
    color: white;
  }
  .chart-toggle.small .toggle-btn {
    padding: 4px 8px;
    font-size: 11px;
  }
  .sessions-toggle {
    border-radius: 4px;
  }
  .sessions-toggle .toggle-btn {
    border-radius: 4px;
  }
  .daily-chart-header {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    margin-bottom: 6px;
  }

  /* ===== DAILY BAR CHART ===== */
  .daily-chart {
    margin-top: 12px;
  }
  .daily-chart-bars {
    display: flex;
    align-items: flex-end;
    height: 200px;
    gap: 4px;
    padding: 8px 4px 36px;
  }
  .daily-bar-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    justify-content: flex-end;
    cursor: pointer;
    position: relative;
    border-radius: 4px 4px 0 0;
    transition: background 0.15s;
    min-width: 0;
  }
  .daily-bar-wrapper:hover {
    background: var(--bg-hover);
  }
  .daily-bar-wrapper.selected {
    background: var(--accent-subtle);
  }
  .daily-bar-wrapper.selected .daily-bar {
    background: var(--accent);
  }
  .daily-bar {
    width: 100%;
    max-width: var(--bar-max-width, 32px);
    background: #ff4d4d;
    border-radius: 3px 3px 0 0;
    min-height: 2px;
    transition: all 0.15s;
    overflow: hidden;
  }
  .daily-bar-wrapper:hover .daily-bar {
    background: #cc3d3d;
  }
  .daily-bar-label {
    position: absolute;
    bottom: -28px;
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    text-align: center;
    transform: rotate(-35deg);
    transform-origin: top center;
  }
  .daily-bar-total {
    position: absolute;
    top: -16px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .daily-bar-tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
    white-space: nowrap;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .daily-bar-wrapper:hover .daily-bar-tooltip {
    opacity: 1;
  }

  /* ===== COST/TOKEN BREAKDOWN BAR ===== */
  .cost-breakdown {
    margin-top: 18px;
    padding: 16px;
    background: var(--bg-secondary);
    border-radius: 8px;
  }
  .cost-breakdown-header {
    font-weight: 600;
    font-size: 15px;
    letter-spacing: -0.02em;
    margin-bottom: 12px;
    color: var(--text-strong);
  }
  .cost-breakdown-bar {
    height: 28px;
    background: var(--bg);
    border-radius: 6px;
    overflow: hidden;
    display: flex;
  }
  .cost-segment {
    height: 100%;
    transition: width 0.3s ease;
    position: relative;
  }
  .cost-segment.output {
    background: #ef4444;
  }
  .cost-segment.input {
    background: #f59e0b;
  }
  .cost-segment.cache-write {
    background: #10b981;
  }
  .cost-segment.cache-read {
    background: #06b6d4;
  }
  .cost-breakdown-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin-top: 12px;
  }
  .cost-breakdown-total {
    margin-top: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text);
    cursor: help;
  }
  .legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .legend-dot.output {
    background: #ef4444;
  }
  .legend-dot.input {
    background: #f59e0b;
  }
  .legend-dot.cache-write {
    background: #10b981;
  }
  .legend-dot.cache-read {
    background: #06b6d4;
  }
  .legend-dot.system {
    background: #ff4d4d;
  }
  .legend-dot.skills {
    background: #8b5cf6;
  }
  .legend-dot.tools {
    background: #ec4899;
  }
  .legend-dot.files {
    background: #f59e0b;
  }
  .cost-breakdown-note {
    margin-top: 10px;
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* ===== SESSION BARS (scrollable list) ===== */
  .session-bars {
    margin-top: 16px;
    max-height: 400px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }
  .session-bar-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.15s;
  }
  .session-bar-row:last-child {
    border-bottom: none;
  }
  .session-bar-row:hover {
    background: var(--bg-hover);
  }
  .session-bar-row.selected {
    background: var(--accent-subtle);
  }
  .session-bar-label {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    color: var(--text);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .session-bar-title {
    /* Prefer showing the full name; wrap instead of truncating. */
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .session-bar-meta {
    font-size: 10px;
    color: var(--text-muted);
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-bar-track {
    flex: 0 0 90px;
    height: 6px;
    background: var(--bg-secondary);
    border-radius: 4px;
    overflow: hidden;
    opacity: 0.6;
  }
  .session-bar-fill {
    height: 100%;
    background: rgba(255, 77, 77, 0.7);
    border-radius: 4px;
    transition: width 0.3s ease;
  }
  .session-bar-value {
    flex: 0 0 70px;
    text-align: right;
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-muted);
  }
  .session-bar-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }
  .session-copy-btn {
    height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .session-copy-btn:hover {
    background: var(--bg);
    border-color: var(--border-strong);
    color: var(--text);
  }

  /* ===== TIME SERIES CHART ===== */
  .session-timeseries {
    margin-top: 24px;
    padding: 16px;
    background: var(--bg-secondary);
    border-radius: 8px;
  }
  .timeseries-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  }
  .timeseries-controls {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .timeseries-header {
    font-weight: 600;
    color: var(--text);
  }
  .timeseries-chart {
    width: 100%;
    overflow: hidden;
  }
  .timeseries-svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .timeseries-svg .axis-label {
    font-size: 10px;
    fill: var(--text-muted);
  }
  .timeseries-svg .ts-area {
    fill: #ff4d4d;
    fill-opacity: 0.1;
  }
  .timeseries-svg .ts-line {
    fill: none;
    stroke: #ff4d4d;
    stroke-width: 2;
  }
  .timeseries-svg .ts-dot {
    fill: #ff4d4d;
    transition: r 0.15s, fill 0.15s;
  }
  .timeseries-svg .ts-dot:hover {
    r: 5;
  }
  .timeseries-svg .ts-bar {
    fill: #ff4d4d;
    transition: fill 0.15s;
  }
  .timeseries-svg .ts-bar:hover {
    fill: #cc3d3d;
  }
  .timeseries-svg .ts-bar.output { fill: #ef4444; }
  .timeseries-svg .ts-bar.input { fill: #f59e0b; }
  .timeseries-svg .ts-bar.cache-write { fill: #10b981; }
  .timeseries-svg .ts-bar.cache-read { fill: #06b6d4; }
  .timeseries-summary {
    margin-top: 12px;
    font-size: 13px;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .timeseries-loading {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
  }

  /* ===== SESSION LOGS ===== */
  .session-logs {
    margin-top: 24px;
    background: var(--bg-secondary);
    border-radius: 8px;
    overflow: hidden;
  }
  .session-logs-header {
    padding: 10px 14px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 13px;
    background: var(--bg-secondary);
  }
  .session-logs-loading {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
  }
  .session-logs-list {
    max-height: 400px;
    overflow-y: auto;
  }
  .session-log-entry {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--bg);
  }
  .session-log-entry:last-child {
    border-bottom: none;
  }
  .session-log-entry.user {
    border-left: 3px solid var(--accent);
  }
  .session-log-entry.assistant {
    border-left: 3px solid var(--border-strong);
  }
  .session-log-meta {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 11px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .session-log-role {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
  }
  .session-log-entry.user .session-log-role {
    color: var(--accent);
  }
  .session-log-entry.assistant .session-log-role {
    color: var(--text-muted);
  }
  .session-log-content {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg-secondary);
    border-radius: 8px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    max-height: 220px;
    overflow-y: auto;
  }

  /* ===== CONTEXT WEIGHT BREAKDOWN ===== */
  .context-weight-breakdown {
    margin-top: 24px;
    padding: 16px;
    background: var(--bg-secondary);
    border-radius: 8px;
  }
  .context-weight-breakdown .context-weight-header {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 4px;
    color: var(--text);
  }
  .context-weight-desc {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 12px 0;
  }
  .context-stacked-bar {
    height: 24px;
    background: var(--bg);
    border-radius: 6px;
    overflow: hidden;
    display: flex;
  }
  .context-segment {
    height: 100%;
    transition: width 0.3s ease;
  }
  .context-segment.system {
    background: #ff4d4d;
  }
  .context-segment.skills {
    background: #8b5cf6;
  }
  .context-segment.tools {
    background: #ec4899;
  }
  .context-segment.files {
    background: #f59e0b;
  }
  .context-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin-top: 12px;
  }
  .context-total {
    margin-top: 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .context-details {
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .context-details summary {
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .context-details[open] summary {
    border-bottom: 1px solid var(--border);
  }
  .context-list {
    max-height: 200px;
    overflow-y: auto;
  }
  .context-list-header {
    display: flex;
    justify-content: space-between;
    padding: 8px 14px;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--text-muted);
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }
  .context-list-item {
    display: flex;
    justify-content: space-between;
    padding: 8px 14px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .context-list-item:last-child {
    border-bottom: none;
  }
  .context-list-item .mono {
    font-family: var(--font-mono);
    color: var(--text);
  }
  .context-list-item .muted {
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  /* ===== NO CONTEXT NOTE ===== */
  .no-context-note {
    margin-top: 24px;
    padding: 16px;
    background: var(--bg-secondary);
    border-radius: 8px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* ===== TWO COLUMN LAYOUT ===== */
  .usage-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    margin-top: 18px;
    align-items: stretch;
  }
  .usage-grid-left {
    display: flex;
    flex-direction: column;
  }
  .usage-grid-right {
    display: flex;
    flex-direction: column;
  }
  
  /* ===== LEFT CARD (Daily + Breakdown) ===== */
  .usage-left-card {
    /* inherits background, border, shadow from .card */
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .usage-left-card .daily-chart-bars {
    flex: 1;
    min-height: 200px;
  }
  .usage-left-card .sessions-panel-title {
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 12px;
  }
  
  /* ===== COMPACT DAILY CHART ===== */
  .daily-chart-compact {
    margin-bottom: 16px;
  }
  .daily-chart-compact .sessions-panel-title {
    margin-bottom: 8px;
  }
  .daily-chart-compact .daily-chart-bars {
    height: 100px;
    padding-bottom: 20px;
  }
  
  /* ===== COMPACT COST BREAKDOWN ===== */
  .cost-breakdown-compact {
    padding: 0;
    margin: 0;
    background: transparent;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .cost-breakdown-compact .cost-breakdown-header {
    margin-bottom: 8px;
  }
  .cost-breakdown-compact .cost-breakdown-legend {
    gap: 12px;
  }
  .cost-breakdown-compact .cost-breakdown-note {
    display: none;
  }
  
  /* ===== SESSIONS CARD ===== */
  .sessions-card {
    /* inherits background, border, shadow from .card */
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .sessions-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .sessions-card-title {
    font-weight: 600;
    font-size: 14px;
  }
  .sessions-card-count {
    font-size: 12px;
    color: var(--text-muted);
  }
  .sessions-card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 8px 0 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .sessions-card-stats {
    display: inline-flex;
    gap: 12px;
  }
  .sessions-sort {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .sessions-sort select {
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-size: 12px;
  }
  .sessions-action-btn {
    height: 28px;
    padding: 0 10px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1;
  }
  .sessions-action-btn.icon {
    width: 32px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .sessions-card-hint {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .sessions-card .session-bars {
    max-height: 280px;
    background: var(--bg);
    border-radius: 6px;
    border: 1px solid var(--border);
    margin: 0;
    overflow-y: auto;
    padding: 8px;
  }
  .sessions-card .session-bar-row {
    padding: 6px 8px;
    border-radius: 6px;
    margin-bottom: 3px;
    border: 1px solid transparent;
    transition: all 0.15s;
  }
  .sessions-card .session-bar-row:hover {
    border-color: var(--border);
    background: var(--bg-hover);
  }
  .sessions-card .session-bar-row.selected {
    border-color: var(--accent);
    background: var(--accent-subtle);
    box-shadow: inset 0 0 0 1px rgba(255, 77, 77, 0.15);
  }
  .sessions-card .session-bar-label {
    flex: 1 1 auto;
    min-width: 140px;
    font-size: 12px;
  }
  .sessions-card .session-bar-value {
    flex: 0 0 60px;
    font-size: 11px;
    font-weight: 600;
  }
  .sessions-card .session-bar-track {
    flex: 0 0 70px;
    height: 5px;
    opacity: 0.5;
  }
  .sessions-card .session-bar-fill {
    background: rgba(255, 77, 77, 0.55);
  }
  .sessions-clear-btn {
    margin-left: auto;
  }
  
  /* ===== EMPTY DETAIL STATE ===== */
  .session-detail-empty {
    margin-top: 18px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 2px dashed var(--border);
    padding: 32px;
    text-align: center;
  }
  .session-detail-empty-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 8px;
  }
  .session-detail-empty-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 16px;
    line-height: 1.5;
  }
  .session-detail-empty-features {
    display: flex;
    justify-content: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  .session-detail-empty-feature {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .session-detail-empty-feature .icon {
    font-size: 16px;
  }
  
  /* ===== SESSION DETAIL PANEL ===== */
  .session-detail-panel {
    margin-top: 12px;
    /* inherits background, border-radius, shadow from .card */
    border: 2px solid var(--accent) !important;
  }
  .session-detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .session-detail-header:hover {
    background: var(--bg-hover);
  }
  .session-detail-title {
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .session-detail-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .session-close-btn {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    cursor: pointer;
    padding: 2px 8px;
    font-size: 16px;
    line-height: 1;
    border-radius: 4px;
    transition: background 0.15s, color 0.15s;
  }
  .session-close-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
    border-color: var(--accent);
  }
  .session-detail-stats {
    display: flex;
    gap: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .session-detail-stats strong {
    color: var(--text);
    font-family: var(--font-mono);
  }
  .session-detail-content {
    padding: 12px;
  }
  .session-summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }
  .session-summary-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    background: var(--bg-secondary);
  }
  .session-summary-title {
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 4px;
  }
  .session-summary-value {
    font-size: 14px;
    font-weight: 600;
  }
  .session-summary-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .session-detail-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    /* Separate "Usage Over Time" from the summary + Top Tools/Model Mix cards above. */
    margin-top: 12px;
    margin-bottom: 10px;
  }
  .session-detail-bottom {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) minmax(0, 1fr);
    gap: 10px;
    align-items: stretch;
  }
  .session-detail-bottom .session-logs-compact {
    margin: 0;
    display: flex;
    flex-direction: column;
  }
  .session-detail-bottom .session-logs-compact .session-logs-list {
    flex: 1 1 auto;
    max-height: none;
  }
  .context-details-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg);
    border-radius: 6px;
    border: 1px solid var(--border);
    padding: 12px;
  }
  .context-breakdown-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 10px;
    margin-top: 8px;
  }
  .context-breakdown-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px;
    background: var(--bg-secondary);
  }
  .context-breakdown-title {
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .context-breakdown-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
  }
  .context-breakdown-item {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .context-breakdown-more {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .context-breakdown-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .context-expand-btn {
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 999px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .context-expand-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
    background: var(--bg);
  }
  
  /* ===== COMPACT TIMESERIES ===== */
  .session-timeseries-compact {
    background: var(--bg);
    border-radius: 6px;
    border: 1px solid var(--border);
    padding: 12px;
    margin: 0;
  }
  .session-timeseries-compact .timeseries-header-row {
    margin-bottom: 8px;
  }
  .session-timeseries-compact .timeseries-header {
    font-size: 12px;
  }
  .session-timeseries-compact .timeseries-summary {
    font-size: 11px;
    margin-top: 8px;
  }
  
  /* ===== COMPACT CONTEXT ===== */
  .context-weight-compact {
    background: var(--bg);
    border-radius: 6px;
    border: 1px solid var(--border);
    padding: 12px;
    margin: 0;
  }
  .context-weight-compact .context-weight-header {
    font-size: 12px;
    margin-bottom: 4px;
  }
  .context-weight-compact .context-weight-desc {
    font-size: 11px;
    margin-bottom: 8px;
  }
  .context-weight-compact .context-stacked-bar {
    height: 16px;
  }
  .context-weight-compact .context-legend {
    font-size: 11px;
    gap: 10px;
    margin-top: 8px;
  }
  .context-weight-compact .context-total {
    font-size: 11px;
    margin-top: 6px;
  }
  .context-weight-compact .context-details {
    margin-top: 8px;
  }
  .context-weight-compact .context-details summary {
    font-size: 12px;
    padding: 6px 10px;
  }
  
  /* ===== COMPACT LOGS ===== */
  .session-logs-compact {
    background: var(--bg);
    border-radius: 10px;
    border: 1px solid var(--border);
    overflow: hidden;
    margin: 0;
    display: flex;
    flex-direction: column;
  }
  .session-logs-compact .session-logs-header {
    padding: 10px 12px;
    font-size: 12px;
  }
  .session-logs-compact .session-logs-list {
    max-height: none;
    flex: 1 1 auto;
    overflow: auto;
  }
  .session-logs-compact .session-log-entry {
    padding: 8px 12px;
  }
  .session-logs-compact .session-log-content {
    font-size: 12px;
    max-height: 160px;
  }
  .session-log-tools {
    margin-top: 6px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
    padding: 6px 8px;
    font-size: 11px;
    color: var(--text);
  }
  .session-log-tools summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .session-log-tools summary::-webkit-details-marker {
    display: none;
  }
  .session-log-tools-list {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .session-log-tools-pill {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 10px;
    background: var(--bg);
    color: var(--text);
  }

  /* ===== RESPONSIVE ===== */
  @media (max-width: 900px) {
    .usage-grid {
      grid-template-columns: 1fr;
    }
    .session-detail-row {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 600px) {
    .session-bar-label {
      flex: 0 0 100px;
    }
    .cost-breakdown-legend {
      gap: 10px;
    }
    .legend-item {
      font-size: 11px;
    }
    .daily-chart-bars {
      height: 170px;
      gap: 6px;
      padding-bottom: 40px;
    }
    .daily-bar-label {
      font-size: 8px;
      bottom: -30px;
      transform: rotate(-45deg);
    }
    .usage-mosaic-grid {
      grid-template-columns: 1fr;
    }
    .usage-hour-grid {
      grid-template-columns: repeat(12, minmax(10px, 1fr));
    }
    .usage-hour-cell {
      height: 22px;
    }
  }
`;
