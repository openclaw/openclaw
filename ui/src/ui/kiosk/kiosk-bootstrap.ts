/**
 * Optional kiosk bootstrap.
 *
 * The kiosk view is intentionally NOT registered as a tab in
 * `ui/src/ui/navigation.ts` -- a wall tablet wants no nav chrome at all.
 * This module exposes a small helper that the host app (`ui/src/ui/app.ts`)
 * can call once on startup to detect the `#/kiosk` hash route and mount
 * the kiosk shell as a sibling to the main app shell.
 *
 * Wiring (one-line addition to `ui/src/ui/app.ts` after the gateway client
 * is ready):
 *
 *   import { mountKioskIfRequested } from "./kiosk/kiosk-bootstrap.js";
 *   mountKioskIfRequested({ client: this.client, mountPoint: document.body });
 *
 * This module does not modify navigation.ts or the existing routing
 * dispatcher. If the URL hash is anything other than `#/kiosk` it is a
 * no-op. The host app continues rendering the normal control UI.
 */

import "./kiosk-shell.js";
import "./kiosk-wagner-way.js";
import type { HaGatewayClient } from "./ha-state-binding.js";

const KIOSK_HASH = "#/kiosk";

export type MountKioskArgs = {
  client: HaGatewayClient;
  mountPoint?: HTMLElement;
  /** Hook for tests to override the location source. */
  locationHash?: string;
};

export type MountKioskResult = {
  mounted: boolean;
  unmount: () => void;
};

export function mountKioskIfRequested(args: MountKioskArgs): MountKioskResult {
  const hash = args.locationHash ?? window.location.hash;
  if (!hashMatchesKiosk(hash)) {
    return { mounted: false, unmount: () => undefined };
  }

  const mountPoint = args.mountPoint ?? document.body;
  const shell = document.createElement("kiosk-shell") as HTMLElement & {
    client: HaGatewayClient;
  };
  shell.client = args.client;

  const view = document.createElement("kiosk-wagner-way");
  shell.appendChild(view);

  // Hide the existing app shell while the kiosk is mounted so it does not
  // bleed through. The shell's own kiosk-mode body class also drives this
  // via CSS, but explicit display:none is a hard guarantee even if the
  // stylesheet has not loaded yet.
  const previousChildren = Array.from(mountPoint.children);
  for (const child of previousChildren) {
    if (child instanceof HTMLElement && child !== shell) {
      child.dataset.kioskHiddenPriorDisplay = child.style.display;
      child.style.display = "none";
    }
  }
  mountPoint.appendChild(shell);

  return {
    mounted: true,
    unmount: () => {
      shell.remove();
      for (const child of previousChildren) {
        if (child instanceof HTMLElement) {
          child.style.display = child.dataset.kioskHiddenPriorDisplay ?? "";
          delete child.dataset.kioskHiddenPriorDisplay;
        }
      }
    },
  };
}

function hashMatchesKiosk(hash: string): boolean {
  if (!hash) return false;
  const trimmed = hash.split("?")[0];
  return trimmed === KIOSK_HASH || trimmed === "#kiosk";
}
