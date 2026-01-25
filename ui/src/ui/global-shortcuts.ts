/**
 * Global Keyboard Shortcuts
 * Handles app-wide keyboard shortcuts that work regardless of current view
 */

import { toggleKeyboardShortcutsModal } from "./components/keyboard-shortcuts-modal";
import type { Tab } from "./navigation";

export type GlobalShortcutsConfig = {
  onNavigate: (tab: Tab) => void;
  onToggleCommandPalette: () => void;
  getCurrentTab: () => Tab;
  onSaveConfig?: () => void;
  onRefresh?: () => void;
};

let config: GlobalShortcutsConfig | null = null;
let isInitialized = false;

/**
 * Check if the event target is an input element
 */
function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toUpperCase();
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Check if a modal/dialog is currently open
 */
function isModalOpen(): boolean {
  return (
    document.querySelector(".modal-backdrop") !== null ||
    document.querySelector("[role='dialog']") !== null ||
    document.querySelector(".command-palette") !== null
  );
}

/**
 * Handle global keyboard shortcuts
 */
function handleGlobalKeydown(event: KeyboardEvent): void {
  if (!config) return;

  const { key, metaKey, ctrlKey, shiftKey, altKey } = event;
  const cmdKey = metaKey || ctrlKey;
  const isInput = isInputElement(event.target);

  // ? - Show keyboard shortcuts (only when not in input)
  if (key === "?" && !isInput && !isModalOpen()) {
    event.preventDefault();
    toggleKeyboardShortcutsModal();
    return;
  }

  // Escape - Close any open modal (handled by modals themselves, but also close shortcuts)
  if (key === "Escape") {
    // Let modals handle their own escape
    return;
  }

  // Cmd+K - Toggle command palette (always works)
  if (cmdKey && key.toLowerCase() === "k" && !shiftKey && !altKey) {
    event.preventDefault();
    config.onToggleCommandPalette();
    return;
  }

  // Skip other shortcuts if in input or modal is open
  if (isInput || isModalOpen()) return;

  // Cmd+1-4 - Quick navigation
  if (cmdKey && !shiftKey && !altKey) {
    const navShortcuts: Record<string, Tab> = {
      "1": "chat",
      "2": "overview",
      "3": "channels",
      "4": "sessions",
    };

    if (key in navShortcuts) {
      event.preventDefault();
      config.onNavigate(navShortcuts[key]);
      return;
    }
  }

  // Cmd+, - Go to config
  if (cmdKey && key === "," && !shiftKey && !altKey) {
    event.preventDefault();
    config.onNavigate("config");
    return;
  }

  // Cmd+S - Save config (when in config view)
  if (cmdKey && key.toLowerCase() === "s" && !shiftKey && !altKey) {
    if (config.getCurrentTab() === "config" && config.onSaveConfig) {
      event.preventDefault();
      config.onSaveConfig();
      return;
    }
  }

  // Cmd+R - Refresh (prevent browser refresh, do app refresh)
  if (cmdKey && key.toLowerCase() === "r" && !shiftKey && !altKey) {
    if (config.onRefresh) {
      event.preventDefault();
      config.onRefresh();
      return;
    }
  }
}

/**
 * Initialize global keyboard shortcuts
 */
export function initGlobalShortcuts(shortcuts: GlobalShortcutsConfig): void {
  if (isInitialized) {
    // Update config if already initialized
    config = shortcuts;
    return;
  }

  config = shortcuts;
  document.addEventListener("keydown", handleGlobalKeydown);
  isInitialized = true;
}

/**
 * Clean up global keyboard shortcuts
 */
export function destroyGlobalShortcuts(): void {
  if (!isInitialized) return;

  document.removeEventListener("keydown", handleGlobalKeydown);
  config = null;
  isInitialized = false;
}

/**
 * Update the shortcuts config
 */
export function updateGlobalShortcutsConfig(
  updates: Partial<GlobalShortcutsConfig>
): void {
  if (config) {
    config = { ...config, ...updates };
  }
}
