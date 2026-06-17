import { html, nothing } from "lit";
import { ref, type RefOrCallback } from "lit/directives/ref.js";
import { icons } from "../icons.ts";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type ShortcutGroup = {
  label: string;
  shortcuts: { keys: string[]; description: string }[];
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: "Navigation",
    shortcuts: [
      { keys: ["Ctrl", "K"], description: "Open command palette" },
      { keys: ["?"], description: "Show keyboard shortcuts" },
      { keys: ["Esc"], description: "Close overlay / cancel" },
    ],
  },
  {
    label: "Chat",
    shortcuts: [
      { keys: ["Enter"], description: "Send message" },
      { keys: ["Shift", "Enter"], description: "New line in composer" },
      { keys: ["↑"], description: "Edit last message (empty input)" },
      { keys: ["Ctrl", "↑"], description: "Scroll to previous message" },
      { keys: ["Ctrl", "↓"], description: "Scroll to next message" },
    ],
  },
  {
    label: "Board / Workboard",
    shortcuts: [
      { keys: ["Drag"], description: "Move card between columns" },
      { keys: ["Enter"], description: "Open card details" },
      { keys: ["Space"], description: "Open card details" },
    ],
  },
  {
    label: "General",
    shortcuts: [
      { keys: ["Tab"], description: "Move focus forward" },
      { keys: ["Shift", "Tab"], description: "Move focus backward" },
      { keys: ["Ctrl", "Z"], description: "Undo (where supported)" },
    ],
  },
];

function renderKey(key: string) {
  return html`<kbd class="shortcut-legend__key">${key}</kbd>`;
}

function renderGroup(group: ShortcutGroup) {
  return html`
    <div class="shortcut-legend__group">
      <h3 class="shortcut-legend__group-label">${group.label}</h3>
      <dl class="shortcut-legend__list">
        ${group.shortcuts.map(
          (s) => html`
            <div class="shortcut-legend__item">
              <dt class="shortcut-legend__keys">
                ${s.keys.map((k, i) =>
                  i === 0
                    ? renderKey(k)
                    : html`<span class="shortcut-legend__plus" aria-hidden="true">+</span
                        >${renderKey(k)}`,
                )}
              </dt>
              <dd class="shortcut-legend__desc">${s.description}</dd>
            </div>
          `,
        )}
      </dl>
    </div>
  `;
}

function trapFocus(e: KeyboardEvent, el: HTMLElement) {
  if (e.key !== "Tab") {
    return;
  }
  const focusable = [...el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (node) => node.isConnected && node.tabIndex >= 0,
  );
  if (focusable.length === 0) {
    e.preventDefault();
    el.focus();
    return;
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusInside = active ? focusable.includes(active) : false;

  if (e.shiftKey && (!focusInside || active === first)) {
    e.preventDefault();
    last.focus();
    return;
  }
  if (!e.shiftKey && (!focusInside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

export type ShortcutLegendProps = {
  open: boolean;
  onClose: () => void;
  dialogRef?: RefOrCallback;
};

export function renderShortcutLegend(props: ShortcutLegendProps) {
  if (!props.open) {
    return nothing;
  }

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    const dialog = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
      ".shortcut-legend__dialog",
    );
    if (dialog) {
      trapFocus(e, dialog);
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains("shortcut-legend__backdrop")) {
      props.onClose();
    }
  };

  return html`
    <div
      class="shortcut-legend__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      @click=${handleBackdropClick}
      @keydown=${handleKeydown}
      ${props.dialogRef ? ref(props.dialogRef) : nothing}
    >
      <div class="shortcut-legend__dialog">
        <div class="shortcut-legend__header">
          <h2 class="shortcut-legend__title">Keyboard Shortcuts</h2>
          <button
            class="btn btn--icon shortcut-legend__close"
            type="button"
            autofocus
            aria-label="Close keyboard shortcuts"
            @click=${() => props.onClose()}
          >
            ${icons.x}
          </button>
        </div>
        <div class="shortcut-legend__body">${SHORTCUT_GROUPS.map(renderGroup)}</div>
      </div>
    </div>
  `;
}
