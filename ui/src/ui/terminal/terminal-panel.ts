import type { FitAddon, Terminal } from "ghostty-web";
// Dockable operator terminal panel for the Control UI.
//
// Renders a VS Code-style shell dock (bottom by default, or right) with session
// tabs. Each tab hosts one ghostty-web terminal wired to a gateway PTY session.
// ghostty-web (WASM, ~0.5MB) is dynamically imported on first open so it never
// weighs down the initial Control UI bundle.
import { LitElement, css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import { TerminalConnection, type TerminalGatewayClient } from "./terminal-connection.ts";
import { terminalTheme } from "./terminal-theme.ts";

// Inline icon set (self-contained; the Control UI blocks external asset loads).
const TERMINAL_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l3 3-3 3M8 11h5" /></svg>`;
const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const PLUS_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10" /></svg>`;
const DOCK_BOTTOM_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 10h12" /></svg>`;
const DOCK_RIGHT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>`;

type TerminalDock = "bottom" | "right";

type PanelLayout = {
  open: boolean;
  dock: TerminalDock;
  height: number;
  width: number;
};

type TerminalTabState = {
  id: string;
  gatewaySessionId: string;
  /** Shell basename shown on the tab, e.g. "zsh". */
  shellName: string;
  /** Agent + cwd shown on hover. */
  hint: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  status: "live" | "exited";
  statusLabel?: string;
  /**
   * Set when the tab is closed while its terminal.open RPC is still in flight
   * (gatewaySessionId is empty in that window, so closeTab cannot close the
   * server session). The open continuation checks this and closes the freshly
   * created session instead of wiring it to the disposed terminal.
   */
  cancelled?: boolean;
};

/** Reduces a shell path to a tab label, e.g. "/bin/zsh" -> "zsh". */
function shellBasename(shell: string): string {
  const base = shell.split(/[\\/]/).pop()?.trim();
  return base && base.length > 0 ? base : "shell";
}

const LAYOUT_KEY = "openclaw.terminal.panel.v1";
const DEFAULT_LAYOUT: PanelLayout = { open: false, dock: "bottom", height: 320, width: 520 };
const MIN_HEIGHT = 140;
const MIN_WIDTH = 320;
const TOGGLE_EVENT = "openclaw:terminal-toggle";

function loadLayout(): PanelLayout {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) {
      return { ...DEFAULT_LAYOUT };
    }
    const parsed = JSON.parse(raw) as Partial<PanelLayout>;
    return {
      open: Boolean(parsed.open),
      dock: parsed.dock === "right" ? "right" : "bottom",
      height: clampSize(parsed.height, MIN_HEIGHT, maxPanelHeight(), DEFAULT_LAYOUT.height),
      width: clampSize(parsed.width, MIN_WIDTH, maxPanelWidth(), DEFAULT_LAYOUT.width),
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

// A size persisted on a large desktop must not swallow a smaller window: cap
// the dock at 80% of the viewport so the header/resizer stay reachable and the
// shell content keeps a usable slice.
function maxPanelHeight(): number {
  return Math.max(MIN_HEIGHT, Math.floor((globalThis.innerHeight || 800) * 0.8));
}

function maxPanelWidth(): number {
  return Math.max(MIN_WIDTH, Math.floor((globalThis.innerWidth || 1280) * 0.8));
}

function clampSize(value: unknown, min: number, max: number, fallback: number): number {
  const size =
    typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
  return Math.min(size, max);
}

/** `<openclaw-terminal-panel>` — the dockable Control UI shell surface. */
export class OpenClawTerminalPanel extends LitElement {
  /** Gateway client used for terminal.* RPCs; null until connected. */
  @property({ attribute: false }) client: TerminalGatewayClient | null = null;
  /** Whether the connected gateway advertises the terminal surface. */
  @property({ type: Boolean }) available = false;
  /** Active Control UI color mode, mirrored into the terminal theme. */
  @property({ attribute: false }) themeMode: "dark" | "light" = "dark";

  @state() private open = false;
  @state() private dock: TerminalDock = "bottom";
  @state() private height = DEFAULT_LAYOUT.height;
  @state() private width = DEFAULT_LAYOUT.width;
  @state() private tabs: TerminalTabState[] = [];
  @state() private activeId: string | null = null;
  @state() private booting = false;
  @state() private errorText: string | null = null;

  private connection: TerminalConnection | null = null;
  private tabSeq = 0;
  private readonly onGlobalKeyDown = (event: KeyboardEvent) => this.handleGlobalKey(event);
  private readonly onToggleRequest = () => this.toggle();
  // Re-clamp a dock sized on a larger window so the header/resizer never end
  // up off-screen after the viewport shrinks (e.g. rotate, window resize).
  private readonly onViewportResize = () => {
    const height = Math.min(this.height, maxPanelHeight());
    const width = Math.min(this.width, maxPanelWidth());
    if (height === this.height && width === this.width) {
      return;
    }
    this.height = height;
    this.width = width;
    this.syncLayoutReservation();
    this.tabs.find((tab) => tab.id === this.activeId)?.fit.fit();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    const layout = loadLayout();
    this.dock = layout.dock;
    this.height = layout.height;
    this.width = layout.width;
    // Only restore the open state when the surface is actually available.
    this.open = layout.open && this.available;
    window.addEventListener("keydown", this.onGlobalKeyDown);
    window.addEventListener(TOGGLE_EVENT, this.onToggleRequest);
    window.addEventListener("resize", this.onViewportResize);
    if (this.open) {
      void this.ensureInitialSession();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onGlobalKeyDown);
    window.removeEventListener(TOGGLE_EVENT, this.onToggleRequest);
    window.removeEventListener("resize", this.onViewportResize);
    // Release the content-area reservation so the shell reflows to full size.
    document.documentElement.style.setProperty("--oc-terminal-reserve-bottom", "0px");
    document.documentElement.style.setProperty("--oc-terminal-reserve-right", "0px");
    this.disposeAllTabs();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("available")) {
      if (!this.available) {
        // The surface disappeared (gateway disconnect/disable). The server kills
        // every PTY on disconnect, so tear down local tabs and the connection
        // (disposeAllTabs drops the gateway subscription too) — otherwise a
        // reopen after reconnect would show a dead session and skip creating a
        // fresh one.
        if (this.open) {
          this.closePanel();
        }
        this.disposeAllTabs();
      } else if (!this.open && loadLayout().open) {
        // Hello arrived after mount; restore the persisted open state.
        this.open = true;
        void this.ensureInitialSession();
      }
    }
    if (changed.has("themeMode")) {
      const theme = terminalTheme(this.themeMode);
      for (const tab of this.tabs) {
        // ghostty-web 0.4.0 ignores options.theme after open() (its option
        // handler only warns), so update the renderer directly and force one
        // full render — the frame loop repaints only dirty rows, which would
        // leave a static screen on the old palette.
        const { term } = tab;
        if (term.renderer && term.wasmTerm) {
          term.renderer.setTheme(theme);
          term.renderer.render(term.wasmTerm, true, term.viewportY, term);
        }
      }
    }
    // Hiding the panel returns `nothing`, which detaches each session's ghostty
    // host. Re-attach live hosts whenever the viewport is rendered so a
    // hide/show cycle keeps the terminals intact instead of blanking them.
    if (this.open) {
      const viewport = this.renderRoot.querySelector(".tp-viewport");
      if (viewport) {
        for (const tab of this.tabs) {
          if (tab.host.parentElement !== viewport) {
            viewport.append(tab.host);
          }
        }
        this.tabs.find((tab) => tab.id === this.activeId)?.fit.fit();
      }
    }
    this.syncLayoutReservation();
  }

  /**
   * Publishes the dock's footprint as CSS variables on the document root so the
   * Control UI shell reserves space for it (via `.content` margins) instead of
   * letting the terminal overlay the chat. The panel itself stays fixed; the
   * content simply shrinks to make room, so this reads as a real dock.
   */
  private syncLayoutReservation(): void {
    const root = document.documentElement.style;
    const bottom =
      this.available && this.open && this.dock === "bottom" ? `${this.height}px` : "0px";
    const right = this.available && this.open && this.dock === "right" ? `${this.width}px` : "0px";
    root.setProperty("--oc-terminal-reserve-bottom", bottom);
    root.setProperty("--oc-terminal-reserve-right", right);
  }

  /** Opens the panel if closed, closes it if open. */
  toggle(): void {
    if (!this.available) {
      return;
    }
    if (this.open) {
      this.closePanel();
    } else {
      this.open = true;
      this.persistLayout();
      void this.ensureInitialSession();
    }
  }

  private closePanel(): void {
    this.open = false;
    this.persistLayout();
  }

  private handleGlobalKey(event: KeyboardEvent): void {
    // Ctrl+` toggles the terminal, matching common IDE shells.
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote") {
      event.preventDefault();
      this.toggle();
    }
  }

  private async ensureInitialSession(): Promise<void> {
    if (this.tabs.length === 0 && !this.booting) {
      await this.openSession();
    }
  }

  private async openSession(): Promise<void> {
    if (!this.client || !this.available || this.booting) {
      return;
    }
    this.booting = true;
    this.errorText = null;
    // Tracked outside the try so the catch can dispose a tab whose open failed.
    let createdTab: TerminalTabState | undefined;
    try {
      const { init, Terminal, FitAddon } = await import("ghostty-web");
      await init();
      if (!this.connection) {
        this.connection = new TerminalConnection(this.client);
      }
      // Captured so the cancelled-open cleanup below can close the session even
      // if a teardown swaps this.connection while the open RPC is in flight.
      const connection = this.connection;
      const host = document.createElement("div");
      host.className = "tp-host";
      const term = new Terminal({
        fontSize: 13,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        cursorBlink: true,
        theme: terminalTheme(this.themeMode),
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);

      const id = `tab-${++this.tabSeq}`;
      const tab: TerminalTabState = {
        id,
        gatewaySessionId: "",
        shellName: t("terminal.tabLabel", { n: String(this.tabSeq) }),
        hint: "",
        term,
        fit,
        host,
        status: "live",
      };
      createdTab = tab;

      this.tabs = [...this.tabs, tab];
      this.activeId = id;
      // Wait for the panel (and its .tp-viewport) to render before attaching the
      // ghostty host, so the terminal opens into a laid-out, measurable node.
      await this.updateComplete;
      const viewport = this.renderRoot.querySelector(".tp-viewport");
      if (!viewport) {
        throw new Error("terminal viewport unavailable");
      }
      viewport.append(host);

      term.open(host);
      fit.fit();
      const cols = term.cols || 80;
      const rows = term.rows || 24;

      const result = await connection.open(
        { cols, rows },
        {
          // The cancelled guard also protects the buffered-event replay inside
          // connection.open from writing to an already-disposed terminal.
          onData: (data) => {
            if (!tab.cancelled) {
              term.write(data);
            }
          },
          onExit: (info) => this.handleExit(id, info),
        },
      );
      if (tab.cancelled) {
        // The tab's close button was clicked while the open RPC was in flight.
        // The server session is live and its sink registered; close it now or
        // it survives invisibly (eating the session cap) until disconnect.
        void connection.close(result.sessionId);
        return;
      }
      tab.gatewaySessionId = result.sessionId;
      tab.shellName = shellBasename(result.shell);
      tab.hint = t("terminal.tabHint", { agent: result.agentId, cwd: result.cwd });

      // Forward keystrokes and viewport resizes to the PTY.
      term.onData((data) => void this.connection?.input(result.sessionId, data));
      term.onResize(({ cols: c, rows: r }) => void this.connection?.resize(result.sessionId, c, r));
      fit.observeResize();

      this.tabs = [...this.tabs];
      term.focus();
    } catch (err) {
      this.errorText = err instanceof Error ? err.message : String(err);
      // A failed open (e.g. terminal disabled or a sandboxed agent is refused)
      // must not leave a phantom "live" tab with no server session. Drop it but
      // keep the panel open so the error stays visible.
      if (createdTab && !createdTab.gatewaySessionId) {
        const dead = createdTab;
        this.disposeTab(dead);
        this.tabs = this.tabs.filter((entry) => entry.id !== dead.id);
        if (this.activeId === dead.id) {
          this.activeId = this.tabs.at(-1)?.id ?? null;
        }
      }
    } finally {
      this.booting = false;
    }
  }

  private handleExit(tabId: string, info: { reason?: string; exitCode: number | null }): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    tab.status = "exited";
    tab.statusLabel =
      info.reason === "process_exit" && info.exitCode !== null
        ? t("terminal.exitedCode", { code: String(info.exitCode) })
        : t("terminal.exited");
    // The connection drops its own sink on exit delivery, so no release() here —
    // the session id may not be recorded yet when an early exit is replayed.
    this.tabs = [...this.tabs];
  }

  private closeTab(tabId: string): void {
    const tab = this.tabs.find((entry) => entry.id === tabId);
    if (!tab) {
      return;
    }
    if (tab.gatewaySessionId && tab.status === "live") {
      void this.connection?.close(tab.gatewaySessionId);
    } else if (!tab.gatewaySessionId && tab.status === "live") {
      // Open still in flight: no session id to close yet. Flag it so the open
      // continuation closes the server session as soon as the RPC resolves.
      tab.cancelled = true;
    }
    this.disposeTab(tab);
    this.tabs = this.tabs.filter((entry) => entry.id !== tabId);
    if (this.activeId === tabId) {
      this.activeId = this.tabs.at(-1)?.id ?? null;
    }
    if (this.tabs.length === 0) {
      this.closePanel();
    }
  }

  private switchTo(tabId: string): void {
    this.activeId = tabId;
    const tab = this.tabs.find((entry) => entry.id === tabId);
    // Refit after the container becomes visible so cols/rows match the viewport.
    void this.updateComplete.then(() => {
      tab?.fit.fit();
      tab?.term.focus();
    });
  }

  private disposeTab(tab: TerminalTabState): void {
    try {
      tab.fit.dispose();
      tab.term.dispose();
      tab.host.remove();
    } catch {
      // Best-effort teardown; a partially-initialized tab may throw.
    }
  }

  private disposeAllTabs(): void {
    for (const tab of this.tabs) {
      if (tab.gatewaySessionId && tab.status === "live") {
        void this.connection?.close(tab.gatewaySessionId);
      }
      // Covers a tab whose open RPC is still in flight; its continuation
      // closes the fresh session instead of adopting the disposed terminal.
      tab.cancelled = true;
      this.disposeTab(tab);
    }
    this.tabs = [];
    this.activeId = null;
    // Drop the gateway subscription with the tabs so the listener never outlives
    // the connection (disconnect/disable/element-removal all route through here).
    this.connection?.dispose();
    this.connection = null;
  }

  private setDock(dock: TerminalDock): void {
    this.dock = dock;
    this.persistLayout();
    void this.updateComplete.then(() => {
      for (const tab of this.tabs) {
        tab.fit.fit();
      }
    });
  }

  private persistLayout(): void {
    try {
      const layout: PanelLayout = {
        open: this.open,
        dock: this.dock,
        height: this.height,
        width: this.width,
      };
      globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Storage may be unavailable (private mode); layout just won't persist.
    }
  }

  private startResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startHeight = this.height;
    const startWidth = this.width;
    const onMove = (move: PointerEvent) => {
      if (this.dock === "bottom") {
        const next = Math.max(MIN_HEIGHT, startHeight + (startY - move.clientY));
        this.height = Math.min(next, maxPanelHeight());
      } else {
        const next = Math.max(MIN_WIDTH, startWidth + (startX - move.clientX));
        this.width = Math.min(next, maxPanelWidth());
      }
      // Reflow the content reservation live so the shell tracks the drag.
      this.syncLayoutReservation();
      const active = this.tabs.find((tab) => tab.id === this.activeId);
      active?.fit.fit();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      this.persistLayout();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  override render() {
    if (!this.available || !this.open) {
      return nothing;
    }
    const style = this.dock === "bottom" ? `height:${this.height}px` : `width:${this.width}px`;
    return html`
      <section class="tp tp--${this.dock}" style=${style} aria-label=${t("terminal.title")}>
        <div
          class="tp-resizer tp-resizer--${this.dock}"
          @pointerdown=${(e: PointerEvent) => this.startResize(e)}
          role="separator"
          aria-label=${t("terminal.resize")}
        ></div>
        <header class="tp-header">
          <div class="tp-tabs" role="tablist">
            ${this.tabs.map(
              (tab) => html`
                <div
                  class="tp-tab ${tab.id === this.activeId ? "is-active" : ""} ${tab.status ===
                  "exited"
                    ? "is-exited"
                    : ""}"
                  role="tab"
                  title=${tab.hint || nothing}
                  aria-selected=${tab.id === this.activeId ? "true" : "false"}
                  @click=${() => this.switchTo(tab.id)}
                >
                  <span class="tp-tab__icon" aria-hidden="true">${TERMINAL_GLYPH}</span>
                  <span class="tp-tab__label">${tab.shellName}</span>
                  ${tab.statusLabel
                    ? html`<span class="tp-tab__status">${tab.statusLabel}</span>`
                    : nothing}
                  <button
                    class="tp-tab__close"
                    type="button"
                    title=${t("terminal.closeSession")}
                    aria-label=${t("terminal.closeSession")}
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      this.closeTab(tab.id);
                    }}
                  >
                    ${CLOSE_GLYPH}
                  </button>
                </div>
              `,
            )}
            <button
              class="tp-new"
              type="button"
              ?disabled=${this.booting}
              title=${t("terminal.newSession")}
              aria-label=${t("terminal.newSession")}
              @click=${() => void this.openSession()}
            >
              ${PLUS_GLYPH}
            </button>
          </div>
          <div class="tp-actions">
            <button
              class="tp-icon ${this.dock === "bottom" ? "is-active" : ""}"
              type="button"
              title=${t("terminal.dockBottom")}
              aria-label=${t("terminal.dockBottom")}
              @click=${() => this.setDock("bottom")}
            >
              ${DOCK_BOTTOM_GLYPH}
            </button>
            <button
              class="tp-icon ${this.dock === "right" ? "is-active" : ""}"
              type="button"
              title=${t("terminal.dockRight")}
              aria-label=${t("terminal.dockRight")}
              @click=${() => this.setDock("right")}
            >
              ${DOCK_RIGHT_GLYPH}
            </button>
            <button
              class="tp-icon"
              type="button"
              title=${t("terminal.hide")}
              aria-label=${t("terminal.hide")}
              @click=${() => this.closePanel()}
            >
              ${CLOSE_GLYPH}
            </button>
          </div>
        </header>
        ${this.errorText
          ? html`<div class="tp-error" role="alert">${this.errorText}</div>`
          : nothing}
        <div class="tp-viewport">
          ${this.booting && this.tabs.length === 0
            ? html`<div class="tp-empty">${t("terminal.starting")}</div>`
            : nothing}
        </div>
      </section>
    `;
  }

  override willUpdate(): void {
    // Keep only the active session's host visible; ghostty renders to a canvas
    // that must be laid out to measure correctly.
    for (const tab of this.tabs) {
      tab.host.style.display = tab.id === this.activeId ? "block" : "none";
    }
  }

  static override styles = css`
    :host {
      position: fixed;
      z-index: 60;
      color: var(--text, #d7dae0);
      font-family: var(--font-sans, system-ui, sans-serif);
    }
    .tp {
      position: fixed;
      display: flex;
      flex-direction: column;
      background: var(--bg, #0e1015);
      overflow: hidden;
    }
    /* A docked panel needs only a single hairline separator on its inner edge —
       no shadow, so it reads as part of the layout rather than a floating card. */
    .tp--bottom {
      left: var(--shell-nav-width, 0);
      right: 0;
      bottom: 0;
      border-top: 1px solid var(--border, #262b34);
    }
    .tp--right {
      top: var(--shell-topbar-height, 0);
      right: 0;
      bottom: 0;
      border-left: 1px solid var(--border, #262b34);
    }
    .tp-resizer {
      position: absolute;
      z-index: 2;
      background: transparent;
    }
    .tp-resizer:hover {
      background: var(--accent, #ff5c5c);
      opacity: 0.5;
    }
    .tp-resizer--bottom {
      top: 0;
      left: 0;
      right: 0;
      height: 5px;
      cursor: ns-resize;
    }
    .tp-resizer--right {
      top: 0;
      bottom: 0;
      left: 0;
      width: 5px;
      cursor: ew-resize;
    }
    .tp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 6px 0 4px;
      border-bottom: 1px solid var(--border, #262b34);
      background: var(--bg, #0e1015);
      min-height: 36px;
    }
    .tp-tabs {
      display: flex;
      align-items: stretch;
      gap: 1px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .tp-tabs::-webkit-scrollbar {
      display: none;
    }
    .tp-tab {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      height: 36px;
      cursor: pointer;
      color: var(--muted, #8a919e);
      white-space: nowrap;
      font-size: 12.5px;
      /* Reserve the active underline height so tabs don't shift on selection. */
      border-bottom: 2px solid transparent;
      transition:
        color 0.12s ease,
        background 0.12s ease;
    }
    .tp-tab:hover {
      color: var(--text, #d7dae0);
      background: color-mix(in srgb, var(--text, #d7dae0) 6%, transparent);
    }
    .tp-tab.is-active {
      color: var(--text, #d7dae0);
      border-bottom-color: var(--accent, #ff5c5c);
    }
    .tp-tab.is-exited {
      opacity: 0.55;
    }
    .tp-tab__icon {
      display: inline-flex;
      color: var(--accent, #4ec9a8);
    }
    .tp-tab.is-exited .tp-tab__icon {
      color: var(--muted, #8a919e);
    }
    .tp-tab__label {
      font-variant-numeric: tabular-nums;
    }
    .tp-tab__status {
      font-size: 11px;
      color: var(--muted, #8a919e);
    }
    .tp-tab__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      opacity: 0;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      border-radius: 4px;
      padding: 0;
    }
    .tp-tab:hover .tp-tab__close,
    .tp-tab.is-active .tp-tab__close {
      opacity: 0.7;
    }
    .tp-new,
    .tp-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border: none;
      background: transparent;
      color: var(--muted, #8a919e);
      cursor: pointer;
      border-radius: 6px;
      padding: 0;
    }
    .tp-tab__close:hover,
    .tp-new:hover,
    .tp-icon:hover {
      background: color-mix(in srgb, var(--text, #d7dae0) 12%, transparent);
      color: var(--text, #d7dae0);
    }
    .tp-icon.is-active {
      color: var(--text, #d7dae0);
      background: color-mix(in srgb, var(--text, #d7dae0) 10%, transparent);
    }
    .tp-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      padding-left: 6px;
    }
    .tp-viewport {
      position: relative;
      flex: 1;
      min-height: 0;
      background: var(--bg, #0e1015);
    }
    .tp-host {
      position: absolute;
      inset: 0;
      padding: 6px 8px;
    }
    .tp-empty,
    .tp-error {
      padding: 10px 12px;
      font-size: 12px;
      color: var(--muted, #8a919e);
    }
    .tp-error {
      color: var(--danger, #ff6b6b);
    }
  `;
}

// Guarded define (not @customElement) so re-imports under a shared registry —
// e.g. vitest with isolate=false — don't throw "already registered".
if (!customElements.get("openclaw-terminal-panel")) {
  customElements.define("openclaw-terminal-panel", OpenClawTerminalPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-terminal-panel": OpenClawTerminalPanel;
  }
}
