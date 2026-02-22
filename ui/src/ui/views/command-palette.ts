import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { icons, type IconName } from "../icons.ts";

type PaletteItem = {
  id: string;
  label: string;
  icon: IconName;
  category: "search" | "navigation" | "skills";
  action: string;
  description?: string;
};

const PALETTE_ITEMS: PaletteItem[] = [
  {
    id: "status",
    label: "/status",
    icon: "radio",
    category: "search",
    action: "/status",
    description: "Show current status",
  },
  {
    id: "models",
    label: "/model",
    icon: "monitor",
    category: "search",
    action: "/model",
    description: "Show/set model",
  },
  {
    id: "usage",
    label: "/usage",
    icon: "barChart",
    category: "search",
    action: "/usage",
    description: "Show usage",
  },
  {
    id: "think",
    label: "/think",
    icon: "brain",
    category: "search",
    action: "/think",
    description: "Set thinking level",
  },
  {
    id: "reset",
    label: "/reset",
    icon: "loader",
    category: "search",
    action: "/reset",
    description: "Reset session",
  },
  {
    id: "help",
    label: "/help",
    icon: "book",
    category: "search",
    action: "/help",
    description: "Show help",
  },
  {
    id: "nav-overview",
    label: "Overview",
    icon: "barChart",
    category: "navigation",
    action: "nav:overview",
  },
  {
    id: "nav-sessions",
    label: "Sessions",
    icon: "fileText",
    category: "navigation",
    action: "nav:sessions",
  },
  {
    id: "nav-cron",
    label: "Scheduled",
    icon: "scrollText",
    category: "navigation",
    action: "nav:cron",
  },
  { id: "nav-skills", label: "Skills", icon: "zap", category: "navigation", action: "nav:skills" },
  {
    id: "nav-config",
    label: "Settings",
    icon: "settings",
    category: "navigation",
    action: "nav:config",
  },
  {
    id: "nav-agents",
    label: "Agents",
    icon: "folder",
    category: "navigation",
    action: "nav:agents",
  },
  {
    id: "skill-shell",
    label: "Shell Command",
    icon: "monitor",
    category: "skills",
    action: "/skill shell",
    description: "Run shell",
  },
  {
    id: "skill-debug",
    label: "Debug Mode",
    icon: "bug",
    category: "skills",
    action: "/verbose full",
    description: "Toggle debug",
  },
];

export type CommandPaletteProps = {
  open: boolean;
  query: string;
  activeIndex: number;
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onNavigate: (tab: string) => void;
  onSlashCommand: (command: string) => void;
};

function filteredItems(query: string): PaletteItem[] {
  if (!query) {
    return PALETTE_ITEMS;
  }
  const q = query.toLowerCase();
  return PALETTE_ITEMS.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      (item.description?.toLowerCase().includes(q) ?? false),
  );
}

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (item.action.startsWith("nav:")) {
    props.onNavigate(item.action.slice(4));
  } else {
    props.onSlashCommand(item.action);
  }
  props.onToggle();
}

function handleKeydown(e: KeyboardEvent, props: CommandPaletteProps) {
  const items = filteredItems(props.query);
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIndexChange(Math.min(props.activeIndex + 1, items.length - 1));
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIndexChange(Math.max(props.activeIndex - 1, 0));
      break;
    case "Enter":
      e.preventDefault();
      if (items[props.activeIndex]) {
        selectItem(items[props.activeIndex], props);
      }
      break;
    case "Escape":
      e.preventDefault();
      props.onToggle();
      break;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  search: "Search",
  navigation: "Navigation",
  skills: "Skills",
};

export function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }

  const items = filteredItems(props.query);
  const grouped = groupItems(items);

  return html`
    <div class="cmd-palette-overlay" @click=${() => props.onToggle()}>
      <div class="cmd-palette" @click=${(e: Event) => e.stopPropagation()}>
        <input
          class="cmd-palette__input"
          placeholder="${t("overview.palette.placeholder")}"
          .value=${props.query}
          @input=${(e: Event) => {
            props.onQueryChange((e.target as HTMLInputElement).value);
            props.onActiveIndexChange(0);
          }}
          @keydown=${(e: KeyboardEvent) => handleKeydown(e, props)}
          autofocus
        />
        <div class="cmd-palette__results">
          ${
            grouped.length === 0
              ? html`<div class="muted" style="padding: 12px 16px">${t("overview.palette.noResults")}</div>`
              : grouped.map(
                  ([category, groupedItems]) => html`
                <div class="cmd-palette__group-label">${CATEGORY_LABELS[category] ?? category}</div>
                ${groupedItems.map((item) => {
                  const globalIndex = items.indexOf(item);
                  const isActive = globalIndex === props.activeIndex;
                  return html`
                    <div
                      class="cmd-palette__item ${isActive ? "cmd-palette__item--active" : ""}"
                      @click=${() => selectItem(item, props)}
                      @mouseenter=${() => props.onActiveIndexChange(globalIndex)}
                    >
                      <span class="nav-item__icon">${icons[item.icon]}</span>
                      <span>${item.label}</span>
                      ${
                        item.description
                          ? html`<span class="cmd-palette__item-desc muted">${item.description}</span>`
                          : nothing
                      }
                    </div>
                  `;
                })}
              `,
                )
          }
        </div>
      </div>
    </div>
  `;
}
