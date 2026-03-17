import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import { SLASH_COMMANDS } from "../chat/slash-commands.ts";
import { icons, type IconName } from "../icons.ts";

type PaletteItem = {
  id: string;
  label: string;
  icon: IconName;
  category: "search" | "navigation" | "skills";
  action: string;
  description?: string;
};

const CMD_DESC_KEYS: Record<string, string> = {
  new: "cmdNew",
  reset: "cmdReset",
  compact: "cmdCompact",
  stop: "cmdStop",
  clear: "cmdClear",
  focus: "cmdFocus",
  model: "cmdModel",
  think: "cmdThink",
  verbose: "cmdVerbose",
  fast: "cmdFast",
  help: "cmdHelp",
  status: "cmdStatus",
  export: "cmdExport",
  usage: "cmdUsage",
  agents: "cmdAgents",
  kill: "cmdKill",
  skill: "cmdSkill",
  steer: "cmdSteer",
};

function getCmdDescription(name: string, fallback: string): string {
  const key = CMD_DESC_KEYS[name];
  return key ? t(`common.${key}`) : fallback;
}

// Lazy evaluation wrapper for command descriptions
const SLASH_PALETTE_ITEMS: (() => PaletteItem)[] = SLASH_COMMANDS.map((command) => {
  return () => ({
    id: `slash:${command.name}`,
    label: `/${command.name}`,
    icon: command.icon ?? "terminal",
    category: "search",
    action: `/${command.name}`,
    description: getCmdDescription(command.name, command.description),
  });
});

// Lazy evaluation wrapper for nav items to support i18n
const NAV_PALETTE_ITEMS: (() => PaletteItem)[] = [
  () => ({
    id: "nav-overview",
    label: t("nav.overview"),
    icon: "barChart",
    category: "navigation",
    action: "nav:overview",
  }),
  () => ({
    id: "nav-sessions",
    label: t("nav.sessions"),
    icon: "fileText",
    category: "navigation",
    action: "nav:sessions",
  }),
  () => ({
    id: "nav-cron",
    label: t("nav.scheduled"),
    icon: "scrollText",
    category: "navigation",
    action: "nav:cron",
  }),
  () => ({
    id: "nav-skills",
    label: t("nav.skills"),
    icon: "zap",
    category: "navigation",
    action: "nav:skills",
  }),
  () => ({
    id: "nav-config",
    label: t("nav.settings"),
    icon: "settings",
    category: "navigation",
    action: "nav:config",
  }),
  () => ({
    id: "nav-agents",
    label: t("nav.agents"),
    icon: "folder",
    category: "navigation",
    action: "nav:agents",
  }),
  () => ({
    id: "skill-shell",
    label: t("nav.shellCommand"),
    icon: "monitor",
    category: "skills",
    action: "/skill shell",
    description: t("nav.shellCommandDesc") || "Run shell",
  }),
  () => ({
    id: "skill-debug",
    label: t("nav.debugMode"),
    icon: "bug",
    category: "skills",
    action: "/verbose full",
    description: t("nav.debugModeDesc") || "Toggle debug",
  }),
];

function getPaletteItems(): PaletteItem[] {
  return [...SLASH_PALETTE_ITEMS.map((fn) => fn()), ...NAV_PALETTE_ITEMS.map((fn) => fn())];
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
  const items = getPaletteItems();
  if (!query) {
    return items;
  }
  const q = query.toLowerCase();
  return items.filter(
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

const CATEGORY_LABELS: Record<string, () => string> = {
  search: () => t("common.search"),
  navigation: () => t("nav.navigation"),
  skills: () => t("nav.skills"),
};

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
                <div class="cmd-palette__group-label">${CATEGORY_LABELS[category]?.() ?? category}</div>
                ${groupedItems.map((item) => {
                  const globalIndex = items.indexOf(item);
                  const isActive = globalIndex === props.activeIndex;
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
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  `;
}
