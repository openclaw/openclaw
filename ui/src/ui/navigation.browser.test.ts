import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClawdisApp } from "./app";

const originalConnect = ClawdisApp.prototype.connect;

function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("clawdis-app") as ClawdisApp;
  document.body.append(app);
  return app;
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

beforeEach(() => {
  ClawdisApp.prototype.connect = () => {
    // no-op: avoid real gateway WS connections in browser tests
  };
  window.__CLAWDIS_CONTROL_UI_BASE_PATH__ = undefined;
  document.body.innerHTML = "";
});

afterEach(() => {
  ClawdisApp.prototype.connect = originalConnect;
  window.__CLAWDIS_CONTROL_UI_BASE_PATH__ = undefined;
  document.body.innerHTML = "";
});

describe("control UI routing", () => {
  it("hydrates the tab from the location", async () => {
    const app = mountApp("/sessions");
    await app.updateComplete;

    expect(app.tab).toBe("sessions");
    expect(window.location.pathname).toBe("/sessions");
  });

  it("respects /ui base paths", async () => {
    const app = mountApp("/ui/cron");
    await app.updateComplete;

    expect(app.basePath).toBe("/ui");
    expect(app.tab).toBe("cron");
    expect(window.location.pathname).toBe("/ui/cron");
  });

  it("infers nested base paths", async () => {
    const app = mountApp("/apps/clawdis/cron");
    await app.updateComplete;

    expect(app.basePath).toBe("/apps/clawdis");
    expect(app.tab).toBe("cron");
    expect(window.location.pathname).toBe("/apps/clawdis/cron");
  });

  it("honors explicit base path overrides", async () => {
    window.__CLAWDIS_CONTROL_UI_BASE_PATH__ = "/clawdis";
    const app = mountApp("/clawdis/sessions");
    await app.updateComplete;

    expect(app.basePath).toBe("/clawdis");
    expect(app.tab).toBe("sessions");
    expect(window.location.pathname).toBe("/clawdis/sessions");
  });

  it("updates the URL when clicking nav items", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>(
      'a.nav-item[href="/connections"]',
    );
    expect(link).not.toBeNull();
    link?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );

    await app.updateComplete;
    expect(app.tab).toBe("connections");
    expect(window.location.pathname).toBe("/connections");
  });

  it("auto-scrolls chat history to the latest message", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const initialContainer = app.querySelector(".chat-thread") as HTMLElement | null;
    expect(initialContainer).not.toBeNull();
    if (!initialContainer) return;
    initialContainer.style.maxHeight = "180px";
    initialContainer.style.overflow = "auto";

    app.chatMessages = Array.from({ length: 60 }, (_, index) => ({
      role: "assistant",
      content: `Line ${index} - ${"x".repeat(200)}`,
      timestamp: Date.now() + index,
    }));

    await app.updateComplete;
    await nextFrame();

    const container = app.querySelector(".chat-thread") as HTMLElement | null;
    expect(container).not.toBeNull();
    if (!container) return;
    const maxScroll = container.scrollHeight - container.clientHeight;
    expect(maxScroll).toBeGreaterThan(0);
    expect(container.scrollTop).toBe(maxScroll);
  });

  it("hydrates token from URL params and strips it", async () => {
    const app = mountApp("/ui/overview?token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.search).toBe("");
  });
});
