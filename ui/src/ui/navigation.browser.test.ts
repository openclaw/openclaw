import { describe, expect, it } from "vitest";
import "../styles.css";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(window.navigator, "maxTouchPoints");

function mountApp(pathname: string) {
  return mountTestApp(pathname);
}

function restoreProperty(target: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

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
    const app = mountApp("/apps/openclaw/cron");
    await app.updateComplete;

    expect(app.basePath).toBe("/apps/openclaw");
    expect(app.tab).toBe("cron");
    expect(window.location.pathname).toBe("/apps/openclaw/cron");
  });

  it("honors explicit base path overrides", async () => {
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = "/openclaw";
    const app = mountApp("/openclaw/sessions");
    await app.updateComplete;

    expect(app.basePath).toBe("/openclaw");
    expect(app.tab).toBe("sessions");
    expect(window.location.pathname).toBe("/openclaw/sessions");
  });

  it("updates the URL when clicking nav items", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/channels"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(window.location.pathname).toBe("/channels");
  });

  it("renders the refreshed top navigation shell", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(app.querySelector(".topnav-shell")).not.toBeNull();
    expect(app.querySelector(".topnav-shell__content")).not.toBeNull();
    expect(app.querySelector(".topnav-shell__actions")).not.toBeNull();
    expect(app.querySelector(".topnav-shell .brand-title")).toBeNull();
  });

  it("renders the refreshed sidebar shell structure", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(app.querySelector(".sidebar-shell")).not.toBeNull();
    expect(app.querySelector(".sidebar-shell__header")).not.toBeNull();
    expect(app.querySelector(".sidebar-shell__body")).not.toBeNull();
    expect(app.querySelector(".sidebar-shell__footer")).not.toBeNull();
    expect(app.querySelector(".sidebar-brand")).not.toBeNull();
    expect(app.querySelector(".sidebar-brand__logo")).not.toBeNull();
    expect(app.querySelector(".sidebar-brand__copy")).not.toBeNull();
  });

  it("uses 16px text controls on iOS mobile to avoid Safari auto-zoom", async () => {
    document.documentElement.setAttribute("data-ios-mobile", "");
    const field = document.createElement("label");
    field.className = "field";
    field.innerHTML = `
      <input type="text" value="alpha" />
      <textarea>beta</textarea>
      <select><option>gamma</option></select>
    `;
    document.body.append(field);
    try {
      const input = field.querySelector("input");
      const textarea = field.querySelector("textarea");
      const select = field.querySelector("select");
      expect(input).not.toBeNull();
      expect(textarea).not.toBeNull();
      expect(select).not.toBeNull();
      if (!input || !textarea || !select) {
        return;
      }

      expect(getComputedStyle(input).fontSize).toBe("16px");
      expect(getComputedStyle(textarea).fontSize).toBe("16px");
      expect(getComputedStyle(select).fontSize).toBe("16px");
    } finally {
      field.remove();
      document.documentElement.removeAttribute("data-ios-mobile");
    }
  });

  it("keeps the mobile shell height override scoped to the iOS viewport fix", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const shell = app.querySelector<HTMLElement>(".shell");
    expect(shell).not.toBeNull();
    if (!shell) {
      return;
    }

    document.documentElement.style.setProperty("--mobile-layout-height", "321px");
    await nextFrame();
    expect(getComputedStyle(shell).height).not.toBe("321px");

    document.documentElement.setAttribute("data-ios-mobile", "");
    app.setAttribute("data-ios-mobile", "");
    await nextFrame();
    expect(getComputedStyle(shell).height).toBe("321px");

    app.removeAttribute("data-ios-mobile");
    document.documentElement.removeAttribute("data-ios-mobile");
    document.documentElement.style.removeProperty("--mobile-layout-height");
  });

  it("does not render a desktop sidebar resizer or inject a custom nav width", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.applySettings({ ...app.settings, navWidth: 360 });
    await app.updateComplete;

    expect(app.querySelector(".sidebar-resizer")).toBeNull();
    const shell = app.querySelector<HTMLElement>(".shell");
    expect(shell?.style.getPropertyValue("--shell-nav-width")).toBe("");
  });

  it("hides section labels in collapsed mode", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.applySettings({ ...app.settings, navCollapsed: true });
    await app.updateComplete;

    expect(app.querySelector(".nav-section__label")).toBeNull();
    expect(app.querySelector(".sidebar-brand__logo")).toBeNull();
  });

  it("keeps footer utilities available in collapsed mode", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.applySettings({ ...app.settings, navCollapsed: true });
    await app.updateComplete;

    expect(app.querySelector(".sidebar-shell__footer")).not.toBeNull();
    expect(app.querySelector(".sidebar-utility-link")).not.toBeNull();
  });

  it("keeps the collapsed desktop rail compact", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.applySettings({ ...app.settings, navCollapsed: true });
    await app.updateComplete;

    const item = app.querySelector<HTMLElement>(".sidebar .nav-item");
    const header = app.querySelector<HTMLElement>(".sidebar-shell__header");
    expect(item).not.toBeNull();
    expect(header).not.toBeNull();
    if (!item || !header) {
      return;
    }

    const itemStyles = getComputedStyle(item);
    const headerStyles = getComputedStyle(header);
    expect(itemStyles.width).toBe("44px");
    expect(itemStyles.minHeight).toBe("44px");
    expect(headerStyles.justifyContent).toBe("center");
  });

  it("resets to the main session when opening chat from sidebar navigation", async () => {
    const app = mountApp("/sessions?session=agent:main:subagent:task-123");
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/chat"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect(app.sessionKey).toBe("main");
    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe("?session=main");
  });

  it("keeps chat and nav usable on narrow viewports", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const split = app.querySelector(".chat-split-container");
    expect(split).not.toBeNull();
    if (split) {
      expect(getComputedStyle(split).position).not.toBe("fixed");
    }

    const chatMain = app.querySelector(".chat-main");
    expect(chatMain).not.toBeNull();
    if (chatMain) {
      expect(getComputedStyle(chatMain).display).not.toBe("none");
    }

    if (split) {
      split.classList.add("chat-split-container--open");
      await app.updateComplete;
      expect(getComputedStyle(split).position).toBe("fixed");
    }
    if (chatMain) {
      expect(getComputedStyle(chatMain).display).toBe("none");
    }
  });

  it("keeps the refreshed top navigation in a single compact row on narrow viewports", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const shell = app.querySelector<HTMLElement>(".topnav-shell");
    const actions = app.querySelector<HTMLElement>(".topnav-shell__actions");
    const content = app.querySelector<HTMLElement>(".topnav-shell__content");
    expect(shell).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(content).not.toBeNull();
    if (!shell || !actions || !content) {
      return;
    }

    expect(getComputedStyle(shell).flexWrap).toBe("nowrap");
    expect(getComputedStyle(actions).order).toBe("2");
    expect(getComputedStyle(content).order).toBe("3");
  });

  it("keeps the mobile topbar nav toggle visible beside the search row", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const shell = app.querySelector<HTMLElement>(".topnav-shell");
    const toggle = app.querySelector<HTMLElement>(".topbar-nav-toggle");
    const actions = app.querySelector<HTMLElement>(".topnav-shell__actions");
    expect(shell).not.toBeNull();
    expect(toggle).not.toBeNull();
    expect(actions).not.toBeNull();
    if (!shell || !toggle || !actions) {
      return;
    }

    const shellWidth = parseFloat(getComputedStyle(shell).width);
    const toggleWidth = parseFloat(getComputedStyle(toggle).width);
    const actionsWidth = parseFloat(getComputedStyle(actions).width);

    expect(toggleWidth).toBeGreaterThan(0);
    expect(actionsWidth).toBeLessThan(shellWidth);
  });

  it("lets the mobile search fill the remaining topbar space", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const actions = app.querySelector<HTMLElement>(".topnav-shell__actions");
    const content = app.querySelector<HTMLElement>(".topnav-shell__content");
    const search = app.querySelector<HTMLElement>(".topbar-search");
    const searchShortcut = app.querySelector<HTMLElement>(".topbar-search__kbd");
    expect(actions).not.toBeNull();
    expect(content).not.toBeNull();
    expect(search).not.toBeNull();
    expect(searchShortcut).not.toBeNull();
    if (!actions || !content || !search || !searchShortcut) {
      return;
    }

    expect(getComputedStyle(actions).flexGrow).toBe("1");
    expect(getComputedStyle(search).flexGrow).toBe("1");
    expect(getComputedStyle(content).flexGrow).toBe("0");
    expect(getComputedStyle(searchShortcut).display).toBe("none");
  });

  it("removes extra top padding from the mobile chat card", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const chat = app.querySelector<HTMLElement>(".chat");
    expect(chat).not.toBeNull();
    if (!chat) {
      return;
    }

    expect(getComputedStyle(chat).paddingTop).toBe("0px");
  });

  it("only enables the iOS shell lock on the chat tab", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    });
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "iPhone",
    });
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      configurable: true,
      value: 5,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: Object.assign(new EventTarget(), { width: 400, height: 800 }),
    });
    try {
      const chatApp = mountApp("/chat");
      await chatApp.updateComplete;

      expect(chatApp.hasAttribute("data-ios-shell-lock")).toBe(true);

      chatApp.remove();
      const sessionsApp = mountApp("/sessions");
      await sessionsApp.updateComplete;

      expect(sessionsApp.hasAttribute("data-ios-shell-lock")).toBe(false);
    } finally {
      restoreProperty(window, "visualViewport", originalVisualViewport);
      restoreProperty(window.navigator, "userAgent", originalUserAgent);
      restoreProperty(window.navigator, "platform", originalPlatform);
      restoreProperty(window.navigator, "maxTouchPoints", originalMaxTouchPoints);
      document.documentElement.removeAttribute("data-ios-mobile");
      document.documentElement.removeAttribute("data-ios-keyboard-open");
      document.documentElement.removeAttribute("data-ios-shell-lock");
      document.body.removeAttribute("data-ios-mobile");
      document.body.removeAttribute("data-ios-keyboard-open");
      document.body.removeAttribute("data-ios-shell-lock");
    }
  });

  it("keeps mobile chat controls on one row as header actions grow", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const sessionRow = app.querySelector<HTMLElement>(
      ".content--chat .content-header .chat-controls__session-row",
    );
    const controls = app.querySelector<HTMLElement>(
      ".content--chat .content-header .chat-controls",
    );
    const session = app.querySelector<HTMLElement>(
      ".content--chat .content-header .chat-controls__session",
    );
    const model = app.querySelector<HTMLElement>(
      ".content--chat .content-header .chat-controls__model",
    );
    expect(sessionRow).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(session).not.toBeNull();
    expect(model).not.toBeNull();
    if (!sessionRow || !controls || !session || !model) {
      return;
    }

    expect(getComputedStyle(sessionRow).display).toBe("flex");
    expect(getComputedStyle(sessionRow).gap).toBe("4px");
    expect(getComputedStyle(session).flexGrow).toBe("2");
    expect(getComputedStyle(model).flexGrow).toBe("3");
    expect(getComputedStyle(controls).display).toBe("flex");
    expect(getComputedStyle(controls).flexWrap).toBe("nowrap");
    expect(getComputedStyle(controls).gap).toBe("4px");
  });

  it("opens the mobile sidenav as a drawer from the topbar toggle", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const toggle = app.querySelector<HTMLButtonElement>(".topbar-nav-toggle");
    const shell = app.querySelector<HTMLElement>(".shell");
    const nav = app.querySelector<HTMLElement>(".shell-nav");
    expect(toggle).not.toBeNull();
    expect(shell).not.toBeNull();
    expect(nav).not.toBeNull();
    if (!toggle || !shell || !nav) {
      return;
    }

    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(false);
    toggle.click();
    await app.updateComplete;

    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(true);
    const styles = getComputedStyle(nav);
    expect(styles.position).toBe("fixed");
    expect(styles.transform).not.toBe("none");
  });

  it("closes the mobile sidenav drawer after navigation", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    const toggle = app.querySelector<HTMLButtonElement>(".topbar-nav-toggle");
    expect(toggle).not.toBeNull();
    toggle?.click();
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/channels"]');
    const shell = app.querySelector<HTMLElement>(".shell");
    expect(link).not.toBeNull();
    expect(shell?.classList.contains("shell--nav-drawer-open")).toBe(true);
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(shell?.classList.contains("shell--nav-drawer-open")).toBe(false);
  });

  it("auto-scrolls chat history to the latest message", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const initialContainer: HTMLElement | null = app.querySelector(".chat-thread");
    expect(initialContainer).not.toBeNull();
    if (!initialContainer) {
      return;
    }
    initialContainer.style.maxHeight = "180px";
    initialContainer.style.overflow = "auto";

    app.chatMessages = Array.from({ length: 60 }, (_, index) => ({
      role: "assistant",
      content: `Line ${index} - ${"x".repeat(200)}`,
      timestamp: Date.now() + index,
    }));

    await app.updateComplete;
    for (let i = 0; i < 6; i++) {
      await nextFrame();
    }

    const container = app.querySelector(".chat-thread");
    expect(container).not.toBeNull();
    if (!container) {
      return;
    }
    const maxScroll = container.scrollHeight - container.clientHeight;
    expect(maxScroll).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      if (container.scrollTop === maxScroll) {
        break;
      }
      await nextFrame();
    }
    expect(container.scrollTop).toBe(maxScroll);
  });

  it("strips query token params without importing them", async () => {
    const app = mountApp("/ui/overview?token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.search).toBe("");
  });

  it("strips password URL params without importing them", async () => {
    const app = mountApp("/ui/overview?password=sekret");
    await app.updateComplete;

    expect(app.password).toBe("");
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.search).toBe("");
  });

  it("hydrates token from URL hash when settings already set", async () => {
    localStorage.setItem(
      "openclaw.control.settings.v1",
      JSON.stringify({ token: "existing-token", gatewayUrl: "wss://gateway.example/openclaw" }),
    );
    const app = mountApp("/ui/overview#token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}")).toMatchObject({
      gatewayUrl: "wss://gateway.example/openclaw",
    });
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.hash).toBe("");
  });

  it("hydrates token from URL hash and strips it", async () => {
    const app = mountApp("/ui/overview#token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.hash).toBe("");
  });

  it("clears the current token when the gateway URL changes", async () => {
    const app = mountApp("/ui/overview#token=abc123");
    await app.updateComplete;

    const gatewayUrlInput = app.querySelector<HTMLInputElement>(
      'input[placeholder="ws://100.x.y.z:18789"]',
    );
    expect(gatewayUrlInput).not.toBeNull();
    gatewayUrlInput!.value = "wss://other-gateway.example/openclaw";
    gatewayUrlInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await app.updateComplete;

    expect(app.settings.gatewayUrl).toBe("wss://other-gateway.example/openclaw");
    expect(app.settings.token).toBe("");
  });

  it("keeps a hash token pending until the gateway URL change is confirmed", async () => {
    const app = mountApp(
      "/ui/overview?gatewayUrl=wss://other-gateway.example/openclaw#token=abc123",
    );
    await app.updateComplete;

    expect(app.settings.gatewayUrl).not.toBe("wss://other-gateway.example/openclaw");
    expect(app.settings.token).toBe("");

    const confirmButton = Array.from(app.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Confirm",
    );
    expect(confirmButton).not.toBeUndefined();
    confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await app.updateComplete;

    expect(app.settings.gatewayUrl).toBe("wss://other-gateway.example/openclaw");
    expect(app.settings.token).toBe("abc123");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("restores the token after a same-tab refresh", async () => {
    const first = mountApp("/ui/overview#token=abc123");
    await first.updateComplete;
    first.remove();

    const refreshed = mountApp("/ui/overview");
    await refreshed.updateComplete;

    expect(refreshed.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
  });
});
