import { html, nothing } from "lit";

export type TrendingItem = {
  type: "x" | "reddit" | "youtube" | "article" | "note";
  author: string;
  content: string;
  date: string;
  url: string;
  tags: string[];
};

export type TrendingCategory = {
  context: string;
  lastUpdated: string;
  updatedBy: string;
  items: TrendingItem[];
};

export type TrendingData = Record<string, TrendingCategory>;

export type TrendingProps = {
  data: TrendingData;
  activeCategory: string;
  onCategoryChange: (category: string) => void;
};

const CATEGORY_META: Record<string, { emoji: string; label: string }> = {
  crypto: { emoji: "\u{1F4B0}", label: "Crypto" },
  ai: { emoji: "\u{1F916}", label: "AI" },
  faith: { emoji: "\u271D\uFE0F", label: "Faith" },
};

const TYPE_ICONS: Record<string, string> = {
  x: "\uD835\uDD4F",
  reddit: "\u{1F534}",
  youtube: "\u25B6\uFE0F",
  article: "\u{1F4F0}",
  note: "\u{1F4A1}",
};

const TYPE_COLORS: Record<string, string> = {
  x: "#1DA1F2",
  reddit: "#FF4500",
  youtube: "#FF0000",
  article: "#818cf8",
  note: "#4fbdba",
};

function formatTrendingDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function renderTrending(props: TrendingProps) {
  const categories = Object.keys(CATEGORY_META);
  const activeCat = props.activeCategory || categories[0] || "crypto";
  const catData = props.data[activeCat];
  const items = catData?.items
    ? [...catData.items].toSorted((a, b) => b.date.localeCompare(a.date))
    : [];

  return html`
    <div class="tr-tabs">
      ${categories.map((cat) => {
        const meta = CATEGORY_META[cat];
        const count = props.data[cat]?.items?.length ?? 0;
        return html`
          <button
            class="tr-tab ${activeCat === cat ? "active" : ""}"
            @click=${() => props.onCategoryChange(cat)}
          >
            <span class="tr-tab-emoji">${meta?.emoji ?? ""}</span>
            <span>${meta?.label ?? cat}</span>
            <span class="tr-tab-count">${count}</span>
          </button>
        `;
      })}
    </div>

    ${
      catData?.context
        ? html`
          <div class="tr-context">
            <div class="tr-context-text">${catData.context}</div>
            <div class="tr-context-meta">
              Updated by ${catData.updatedBy}
              ${catData.lastUpdated ? html` · ${formatTrendingDate(catData.lastUpdated)}` : nothing}
            </div>
          </div>
        `
        : nothing
    }

    <div class="tr-feed">
      ${
        items.length === 0
          ? html`
              <div class="tr-empty">No items yet for this category.</div>
            `
          : items.map(
              (item) => html`
              <div
                class="tr-item ${item.url ? "tr-item--clickable" : ""}"
                style="--tr-type-color: ${TYPE_COLORS[item.type] ?? "var(--muted)"}"
                @click=${() => {
                  if (item.url) {
                    window.open(item.url, "_blank", "noopener,noreferrer");
                  }
                }}
              >
                <div class="tr-item-icon">${TYPE_ICONS[item.type] ?? ""}</div>
                <div class="tr-item-body">
                  <div class="tr-item-header">
                    <span class="tr-item-author">${item.author}</span>
                    <span class="tr-item-date">${formatTrendingDate(item.date)}</span>
                  </div>
                  <div class="tr-item-content">${item.content}</div>
                  ${
                    item.tags.length > 0
                      ? html`
                        <div class="tr-item-tags">
                          ${item.tags.map((tag) => html`<span class="tr-tag">#${tag}</span>`)}
                        </div>
                      `
                      : nothing
                  }
                </div>
              </div>
            `,
            )
      }
    </div>
  `;
}
