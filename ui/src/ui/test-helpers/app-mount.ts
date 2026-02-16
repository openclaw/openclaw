import { afterEach, beforeEach } from "vitest";
import { SmartAgentNeoApp } from "../app.ts";

// oxlint-disable-next-line typescript/unbound-method
const originalConnect = SmartAgentNeoApp.prototype.connect;

export function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("smart-agent-neo-app") as SmartAgentNeoApp;
  document.body.append(app);
  return app;
}

export function registerAppMountHooks() {
  beforeEach(() => {
    SmartAgentNeoApp.prototype.connect = () => {
      // no-op: avoid real gateway WS connections in browser tests
    };
    window.__SMART_AGENT_NEO_CONTROL_UI_BASE_PATH__ = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    SmartAgentNeoApp.prototype.connect = originalConnect;
    window.__SMART_AGENT_NEO_CONTROL_UI_BASE_PATH__ = undefined;
    localStorage.clear();
    document.body.innerHTML = "";
  });
}
