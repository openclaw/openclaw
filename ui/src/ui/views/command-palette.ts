import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import { SLASH_COMMANDS } from "../chat/slash-commands.ts";
import { icons, type IconName } from "../icons.ts";

type PaletteItem = {
  id: string;
  label?: string;
  labelKey?: string;
  icon: IconName;
  category: "search" | "navigation" | "skills";
  action: string;
  descriptionKey?: string;
  description?: string;
};

const SLASH_PALETTE_ITEMS: PaletteItem[] = SLASH_COMMANDS.map((command) => ({
  id: `slash:${command.name}`,
  label: `/${command.name}`,
  icon: command.icon ?? "terminal",
  category: "search",
  action: `/${command.name}`,
  description: command.description,
}));

const PALETTE_ITEMS: PaletteItem[] = [
  ...SLASH_PALETTE_ITEMS,
  {
    id: "nav-overview",
    labelKey: "overview.palette.items.overview",
    icon: "barChart",
    category: "navigation",
    action: "nav:overview",
  },
  {
    id: "nav-sessions",
    labelKey: "overview.palette.items.sessions",
    icon: "fileText",
    category: "navigation",
    action: "nav:sessions",
  },
  {
    id: "nav-cron",
    labelKey: "overview.palette.items.scheduled",
    icon: "scrollText",
    category: "navigation",
    action: "nav:cron",
  },
  {
    id: "nav-skills",
    labelKey: "overview.palette.items.skills",
    icon: "zap",
    category: "navigation",
    action: "nav:skills",
  },
  {
    id: "nav-config",
    labelKey: "overview.palette.items.settings",
    icon: "settings",
    category: "navigation",
    action: "nav:config",
  },
  {
    id: "nav-agents",
    labelKey: "overview.palette.items.agents",
    icon: "folder",
    category: "navigation",
    action: "nav:agents",
  },
  {
    id: "skill-shell",
    labelKey: "overview.palette.items.shellCommand",
    icon: "monitor",
    category: "skills",
    action: "/skill shell",
    descriptionKey: "overview.palette.descriptions.runShell",
  },
  {
    id: "skill-debug",
    labelKey: "overview.palette.items.debugMode",
    icon: "bug",
    category: "skills",
    action: "/verbose full",
    descriptionKey: "overview.palette.descriptions.toggleDebug",
  },
];

export function getPaletteItems(): readonly PaletteItem[] {
  return PALETTE_ITEMS;
}

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
      getPaletteLabel(item).toLowerCase().includes(q) ||
      (getPaletteDescription(item)?.toLowerCase().includes(q) ?? false),
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

let previouslyFocused: Element | null = null;

function saveFocus() {
  previouslyFocused = document.activeElement;
}

function restoreFocus() {
  if (previouslyFocused && previouslyFocused instanceof HTMLElement) {
    requestAnimationFrame(() => previouslyFocused && (previouslyFocused as HTMLElement).focus());
  }
  previouslyFocused = null;
}

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (item.action.startsWith("nav:")) {
    props.onNavigate(item.action.slice(4));
  } else {
    props.onSlashCommand(item.action);
  }
  props.onToggle();
  restoreFocus();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(e: KeyboardEvent, props: CommandPaletteProps) {
  const items = filteredItems(props.query);
  if (items.length === 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex + 1) % items.length);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex - 1 + items.length) % items.length);
      scrollActiveIntoView();
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
      restoreFocus();
      break;
  }
}

const CATEGORY_LABEL_KEYS: Record<string, string> = {
  search: "overview.palette.groups.search",
  navigation: "overview.palette.groups.navigation",
  skills: "overview.palette.groups.skills",
};

function getPaletteLabel(item: PaletteItem): string {
  return item.labelKey ? t(item.labelKey) : (item.label ?? item.id);
}

function getPaletteDescription(item: PaletteItem): string | undefined {
  return item.descriptionKey ? t(item.descriptionKey) : item.description;
}

function getCategoryLabel(category: string): string {
  const key = CATEGORY_LABEL_KEYS[category];
  return key ? t(key) : category;
}

function focusInput(el: Element | undefined) {
  if (el) {
    saveFocus();
    requestAnimationFrame(() => (el as HTMLInputElement).focus());
  }
}

export function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }

  const items = filteredItems(props.query);
  const grouped = groupItems(items);

  return html`
    <div class="cmd-palette-overlay" @click=${() => {
      props.onToggle();
      restoreFocus();
    }}>
      <div
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props)}
      >
        <input
          ${ref(focusInput)}
          class="cmd-palette__input"
          placeholder="${t("overview.palette.placeholder")}"
          .value=${props.query}
          @input=${(e: Event) => {
            props.onQueryChange((e.target as HTMLInputElement).value);
            props.onActiveIndexChange(0);
          }}
        />
        <div class="cmd-palette__results">
          ${
            grouped.length === 0
              ? html`<div class="cmd-palette__empty">
                  <span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px">${icons.search}</span>
                  <span>${t("overview.palette.noResults")}</span>
                </div>`
              : grouped.map(
                  ([category, groupedItems]) => html`
                <div class="cmd-palette__group-label">${getCategoryLabel(category)}</div>
                ${groupedItems.map((item) => {
                  const globalIndex = items.indexOf(item);
                  const isActive = globalIndex === props.activeIndex;
                  const description = getPaletteDescription(item);
                  return html`
                    <div
                      class="cmd-palette__item ${isActive ? "cmd-palette__item--active" : ""}"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        selectItem(item, props);
                      }}
                      @mouseenter=${() => props.onActiveIndexChange(globalIndex)}
                    >
                      <span class="nav-item__icon">${icons[item.icon]}</span>
                      <span>${getPaletteLabel(item)}</span>
                      ${
                        description
                          ? html`<span class="cmd-palette__item-desc muted">${description}</span>`
                          : nothing
                      }
                    </div>
                  `;
                })}
              `,
                )
          }
        </div>
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> ${t("overview.palette.hints.navigate")}</span>
          <span><kbd>↵</kbd> ${t("overview.palette.hints.select")}</span>
          <span><kbd>esc</kbd> ${t("overview.palette.hints.close")}</span>
        </div>
      </div>
    </div>
  `;
}
