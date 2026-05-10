/**
 * Wall-tablet kiosk shell.
 *
 * Renders the no-chrome surface that hosts the Wagner Way overview view
 * (and future v2 views). Sets the `kiosk-mode` class on the document
 * root on mount so CSS hides nav and chat. Subscribes to the gateway
 * via HaStateBinding and surfaces a small connection-state pill in the
 * top-right.
 *
 * The actual dashboard content slot is provided by `kiosk-wagner-way.ts`
 * (Unit 7); this shell is layout + connection plumbing only.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import {
  HaStateBinding,
  type HaConnectionState,
  type HaGatewayClient,
} from "./ha-state-binding.js";

const KIOSK_MODE_CLASS = "kiosk-mode";

export class KioskShell extends LitElement {
  override createRenderRoot() {
    return this;
  }

  /**
   * The gateway client to talk to OpenClaw. Set by the bootstrap when
   * the kiosk URL is detected; tests pass a fake.
   */
  @property({ attribute: false })
  client: HaGatewayClient | null = null;

  @state() private binding: HaStateBinding | null = null;
  @state() private connection: HaConnectionState = "idle";

  private wakeLockSentinel: { release: () => Promise<void> } | null = null;
  private removeConnectionListener: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    document.documentElement.classList.add(KIOSK_MODE_CLASS);
    this.requestWakeLock();
    if (this.client) {
      this.attachClient(this.client);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.documentElement.classList.remove(KIOSK_MODE_CLASS);
    this.releaseWakeLock();
    this.detachClient();
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("client")) {
      this.detachClient();
      if (this.client) {
        this.attachClient(this.client);
      }
    }
  }

  /** Public for tests + the wagner-way view. */
  getBinding(): HaStateBinding | null {
    return this.binding;
  }

  override render(): TemplateResult {
    return html`
      <div class="kiosk-shell" data-connection=${this.connection}>
        <header class="kiosk-shell__header">
          <h1 class="kiosk-shell__title">
            <slot name="title">Wagner Way</slot>
          </h1>
          <div
            class="kiosk-shell__pill kiosk-shell__pill--${this.connection}"
            role="status"
            aria-live="polite"
            data-test-id="kiosk-connection-pill"
          >
            ${labelForConnection(this.connection)}
          </div>
        </header>
        <main class="kiosk-shell__body">
          ${this.binding
            ? html`<slot></slot>`
            : html`<div class="kiosk-shell__placeholder">Connecting to Home Assistant...</div>`}
        </main>
      </div>
    `;
  }

  // -- internals -----------------------------------------------------------

  private attachClient(client: HaGatewayClient): void {
    const binding = new HaStateBinding(client);
    this.binding = binding;
    this.removeConnectionListener = binding.onConnectionStateChange((state) => {
      this.connection = state;
    });
    void binding.attach();
  }

  private detachClient(): void {
    this.removeConnectionListener?.();
    this.removeConnectionListener = null;
    this.binding?.detach();
    this.binding = null;
    this.connection = "idle";
  }

  private requestWakeLock(): void {
    const navAny = navigator as unknown as {
      wakeLock?: { request: (type: string) => Promise<{ release: () => Promise<void> }> };
    };
    if (!navAny.wakeLock || typeof navAny.wakeLock.request !== "function") {
      return;
    }
    navAny.wakeLock
      .request("screen")
      .then((sentinel) => {
        this.wakeLockSentinel = sentinel;
      })
      .catch(() => {
        // best-effort; the OS may decline.
      });
  }

  private releaseWakeLock(): void {
    if (this.wakeLockSentinel) {
      void this.wakeLockSentinel.release().catch(() => undefined);
      this.wakeLockSentinel = null;
    }
  }
}

function labelForConnection(state: HaConnectionState): string {
  switch (state) {
    case "live":
      return "live";
    case "attaching":
      return "connecting";
    case "degraded":
      return "reconnecting";
    case "detached":
      return "off";
    default:
      return "idle";
  }
}

if (!customElements.get("kiosk-shell")) {
  customElements.define("kiosk-shell", KioskShell);
}
