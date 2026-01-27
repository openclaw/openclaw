import { html, nothing } from "lit";

import { clampText } from "../format";
import type {
  MarketplaceInstalledSkill,
  MarketplaceMessageMap,
  MarketplaceSearchResult,
  MarketplaceUpdateCheck,
} from "../controllers/marketplace";

export type MarketplaceProps = {
  loading: boolean;
  searching: boolean;
  query: string;
  results: MarketplaceSearchResult[];
  installed: MarketplaceInstalledSkill[];
  updates: MarketplaceUpdateCheck[];
  error: string | null;
  busySlug: string | null;
  messages: MarketplaceMessageMap;
  tab: "browse" | "installed";
  onQueryChange: (query: string) => void;
  onSearch: (query: string) => void;
  onInstall: (slug: string, version?: string) => void;
  onCheckUpdates: () => void;
  onRefresh: () => void;
  onTabChange: (tab: "browse" | "installed") => void;
};

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
}

function renderStars(count: number) {
  return html`<span class="marketplace-stars" title="${count} stars">★ ${formatNumber(count)}</span>`;
}

function renderDownloads(count: number) {
  return html`<span class="marketplace-downloads" title="${count} downloads">↓ ${formatNumber(count)}</span>`;
}

export function renderMarketplace(props: MarketplaceProps) {
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">ClawdHub Marketplace</div>
          <div class="card-sub">Browse and install skills from the public registry.</div>
        </div>
        <div class="row" style="gap: 8px;">
          <button
            class="btn"
            ?disabled=${props.loading}
            @click=${props.onCheckUpdates}
          >
            Check Updates
          </button>
          <button
            class="btn"
            ?disabled=${props.loading}
            @click=${props.onRefresh}
          >
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      <div class="marketplace-tabs" style="margin-top: 16px;">
        <button
          class="marketplace-tab ${props.tab === "browse" ? "marketplace-tab--active" : ""}"
          @click=${() => props.onTabChange("browse")}
        >
          Browse
        </button>
        <button
          class="marketplace-tab ${props.tab === "installed" ? "marketplace-tab--active" : ""}"
          @click=${() => props.onTabChange("installed")}
        >
          Installed (${props.installed.length})
        </button>
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}

      ${props.tab === "browse" ? renderBrowseTab(props) : renderInstalledTab(props)}
    </section>

    <style>
      .marketplace-tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--border-color, #333);
        padding-bottom: 0;
      }
      .marketplace-tab {
        padding: 8px 16px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        cursor: pointer;
        color: var(--text-secondary, #888);
        font-size: 14px;
      }
      .marketplace-tab:hover {
        color: var(--text-primary, #fff);
      }
      .marketplace-tab--active {
        color: var(--text-primary, #fff);
        border-bottom-color: var(--accent-color, #0ea5e9);
      }
      .marketplace-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 16px;
        margin-top: 16px;
      }
      .marketplace-card {
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        padding: 16px;
        background: var(--bg-secondary, #1a1a1a);
      }
      .marketplace-card-header {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 8px;
      }
      .marketplace-emoji {
        font-size: 24px;
        line-height: 1;
      }
      .marketplace-card-title {
        font-weight: 600;
        font-size: 16px;
        color: var(--text-primary, #fff);
      }
      .marketplace-card-author {
        font-size: 12px;
        color: var(--text-secondary, #888);
      }
      .marketplace-card-desc {
        font-size: 14px;
        color: var(--text-secondary, #aaa);
        margin-bottom: 12px;
        line-height: 1.4;
      }
      .marketplace-card-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 12px;
      }
      .marketplace-stars,
      .marketplace-downloads {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .marketplace-card-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .marketplace-version {
        font-size: 12px;
        color: var(--text-secondary, #888);
        font-family: var(--font-mono, monospace);
      }
      .marketplace-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }
      .marketplace-tag {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--bg-tertiary, #252525);
        color: var(--text-secondary, #888);
      }
      .marketplace-update-badge {
        display: inline-block;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--warning-bg, #553300);
        color: var(--warning-color, #ffaa00);
        margin-left: 8px;
      }
    </style>
  `;
}

function renderBrowseTab(props: MarketplaceProps) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      props.onSearch(props.query);
    }
  };

  return html`
    <div class="filters" style="margin-top: 16px;">
      <label class="field" style="flex: 1;">
        <span>Search ClawdHub</span>
        <input
          type="text"
          .value=${props.query}
          @input=${(e: Event) => props.onQueryChange((e.target as HTMLInputElement).value)}
          @keydown=${handleKeyDown}
          placeholder="Search for skills (e.g., calendar, github, notion)"
        />
      </label>
      <button
        class="btn primary"
        ?disabled=${props.searching || !props.query.trim()}
        @click=${() => props.onSearch(props.query)}
      >
        ${props.searching ? "Searching…" : "Search"}
      </button>
    </div>

    ${props.results.length === 0 && !props.searching
      ? html`
          <div class="muted" style="margin-top: 24px; text-align: center;">
            ${props.query
              ? "No skills found. Try a different search term."
              : "Search for skills to get started."}
          </div>
        `
      : html`
          <div class="marketplace-grid">
            ${props.results.map((skill) => renderSkillCard(skill, props))}
          </div>
        `}
  `;
}

function renderInstalledTab(props: MarketplaceProps) {
  if (props.installed.length === 0) {
    return html`
      <div class="muted" style="margin-top: 24px; text-align: center;">
        No ClawdHub skills installed yet. Browse and install skills from the marketplace.
      </div>
    `;
  }

  return html`
    <div class="marketplace-grid">
      ${props.installed.map((skill) => renderInstalledCard(skill, props))}
    </div>
  `;
}

function renderSkillCard(skill: MarketplaceSearchResult, props: MarketplaceProps) {
  const busy = props.busySlug === skill.slug;
  const message = props.messages[skill.slug];
  const isInstalled = props.installed.some((s) => s.slug === skill.slug);

  return html`
    <div class="marketplace-card">
      <div class="marketplace-card-header">
        ${skill.emoji ? html`<span class="marketplace-emoji">${skill.emoji}</span>` : nothing}
        <div>
          <div class="marketplace-card-title">${skill.name}</div>
          ${skill.author
            ? html`<div class="marketplace-card-author">by ${skill.author}</div>`
            : nothing}
        </div>
      </div>
      <div class="marketplace-card-desc">${clampText(skill.description, 120)}</div>
      ${skill.tags.length > 0
        ? html`
            <div class="marketplace-tags">
              ${skill.tags.slice(0, 4).map((tag) => html`<span class="marketplace-tag">${tag}</span>`)}
            </div>
          `
        : nothing}
      <div class="marketplace-card-meta">
        ${renderStars(skill.stars)}
        ${renderDownloads(skill.downloads)}
        <span>Updated ${formatDate(skill.updatedAt)}</span>
      </div>
      <div class="marketplace-card-footer">
        <span class="marketplace-version">v${skill.version}</span>
        <button
          class="btn ${isInstalled ? "" : "primary"}"
          ?disabled=${busy}
          @click=${() => props.onInstall(skill.slug, skill.version)}
        >
          ${busy ? "Installing…" : isInstalled ? "Reinstall" : "Install"}
        </button>
      </div>
      ${message
        ? html`
            <div
              class="muted"
              style="margin-top: 8px; font-size: 12px; color: ${message.kind === "error"
                ? "var(--danger-color, #d14343)"
                : "var(--success-color, #0a7f5a)"};"
            >
              ${message.message}
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderInstalledCard(skill: MarketplaceInstalledSkill, props: MarketplaceProps) {
  const busy = props.busySlug === skill.slug;
  const message = props.messages[skill.slug];
  const updateCheck = props.updates.find((u) => u.slug === skill.slug);
  const hasUpdate = updateCheck?.hasUpdate ?? false;

  return html`
    <div class="marketplace-card">
      <div class="marketplace-card-header">
        ${skill.emoji ? html`<span class="marketplace-emoji">${skill.emoji}</span>` : nothing}
        <div>
          <div class="marketplace-card-title">
            ${skill.name || skill.slug}
            ${hasUpdate
              ? html`<span class="marketplace-update-badge">Update available</span>`
              : nothing}
          </div>
        </div>
      </div>
      ${skill.description
        ? html`<div class="marketplace-card-desc">${clampText(skill.description, 120)}</div>`
        : nothing}
      <div class="marketplace-card-meta">
        <span>Installed ${formatDate(skill.installedAt)}</span>
      </div>
      <div class="marketplace-card-footer">
        <span class="marketplace-version">
          v${skill.version}
          ${hasUpdate && updateCheck
            ? html` → v${updateCheck.latestVersion}`
            : nothing}
        </span>
        ${hasUpdate && updateCheck
          ? html`
              <button
                class="btn primary"
                ?disabled=${busy}
                @click=${() => props.onInstall(skill.slug, updateCheck.latestVersion)}
              >
                ${busy ? "Updating…" : "Update"}
              </button>
            `
          : html`
              <button
                class="btn"
                ?disabled=${busy}
                @click=${() => props.onInstall(skill.slug)}
              >
                ${busy ? "Reinstalling…" : "Reinstall"}
              </button>
            `}
      </div>
      ${message
        ? html`
            <div
              class="muted"
              style="margin-top: 8px; font-size: 12px; color: ${message.kind === "error"
                ? "var(--danger-color, #d14343)"
                : "var(--success-color, #0a7f5a)"};"
            >
              ${message.message}
            </div>
          `
        : nothing}
    </div>
  `;
}
