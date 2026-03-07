import { afterEach, beforeEach } from "vitest";
import "../app.ts";
import type { OpenClawApp } from "../app.ts";
import type { GatewayHelloOk } from "../gateway.ts";

type MountHarnessApp = OpenClawApp & {
  client?: { stop: () => void } | null;
  connected?: boolean;
  hello?: GatewayHelloOk | null;
  lastError?: string | null;
};

export function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  app.connect = () => {
    // no-op: avoid real gateway WS connections in browser tests
  };
  document.body.append(app);
  const mounted = app as MountHarnessApp;
  // Browser tests exercise rendered UI behavior, not live gateway transport.
  // Force a connected shell and neutralize any background client started by lifecycle hooks.
  mounted.client?.stop();
  mounted.client = null;
  mounted.connected = true;
  mounted.lastError = null;
  mounted.hello = mounted.hello ?? null;
  return app;
}

export function registerAppMountHooks() {
  beforeEach(() => {
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
  });
}
