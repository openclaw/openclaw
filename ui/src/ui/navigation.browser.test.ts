import { afterEach, describe, expect, it, vi } from "vitest";
import "../test-helpers/load-styles.ts";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

afterEach(() => {
  vi.restoreAllMocks();
});

function mountApp(pathname: string) {
  return mountTestApp(pathname);
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function findConfirmButton(app: ReturnType<typeof mountApp>) {
  return Array.from(app.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === "Confirm",
  );
}

async function confirmPendingGatewayChange(app: ReturnType<typeof mountApp>) {
  const confirmButton = findConfirmButton(app);
  expect(confirmButton).not.toBeUndefined();
  confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await app.updateComplete;
}

function expectConfirmedGatewayChange(app: ReturnType<typeof mountApp>) {
  expect(app.settings.gatewayUrl).toBe("wss://other-gateway.example/openclaw");
  expect(app.settings.token).toBe("abc123");
  expect(window.location.search).toBe("");
  expect(window.location.hash).toBe("");
}

describe("control UI routing", () => {
  it("keeps chat navigation links visible and updates the URL when clicked", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const dreamsLink = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/dreaming"]');
    expect(dreamsLink).not.toBeNull();

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/channels"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(window.location.pathname).toBe("/channels");
  });

  it("renders the dreaming view on the /dreaming route", async () => {
    const app = mountApp("/dreaming");
    app.dreamingStatus = {
      enabled: true,
      timezone: "Europe/Madrid",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 2,
      recallSignalCount: 1,
      dailySignalCount: 1,
      groundedSignalCount: 0,
      totalSignalCount: 2,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 1,
      promotedToday: 1,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { enabled: true, cron: "", managedCronPresent: false, lookbackDays: 7, limit: 20 },
        deep: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          limit: 20,
          minScore: 0.75,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 7,
        },
        rem: {
          enabled: true,
          cron: "",
          managedCronPresent: false,
          lookbackDays: 7,
          limit: 20,
          minPatternStrength: 0.6,
        },
      },
    };
    app.dreamDiaryPath = "DREAMS.md";
    app.dreamDiaryContent = [
      "# Dream Diary",
      "",
      "<!-- openclaw:dreaming:diary:start -->",
      "",
      "---",
      "",
      "*January 1, 2026*",
      "",
      "What Happened",
      "1. Stable operator rule surfaced.",
      "",
      "<!-- openclaw:dreaming:diary:end -->",
    ].join("\n");
    app.requestUpdate();
    await app.updateComplete;

    expect(app.tab).toBe("dreams");
    expect(app.querySelector(".dreams__tab")).not.toBeNull();
    expect(app.querySelector(".dreams__lobster")).not.toBeNull();
  });

  it("renders responsive navigation shell, drawer, and collapsed states", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    expect(window.matchMedia("(max-width: 768px)").matches).toBe(true);

    expect(app.querySelector(".topnav-shell")).not.toBeNull();
    expect(app.querySelector(".topnav-shell__content")).not.toBeNull();
    expect(app.querySelector(".topnav-shell__actions")).not.toBeNull();
    expect(app.querySelector(".topnav-shell .brand-title")).toBeNull();

    expect(app.querySelector(".sidebar-shell")).not.toBeNull();
    expect(app.querySelector(".sidebar-shell__header")).not.toBeNull();
    expect(app.querySelector(".sidebar-shell__body")).not.toBeNull();
    expect(app.querySelector(".sidebar-shell__footer")).not.toBeNull();
    expect(app.querySelector(".sidebar-brand")).not.toBeNull();
    expect(app.querySelector(".sidebar-brand__logo")).not.toBeNull();
    expect(app.querySelector(".sidebar-brand__copy")).not.toBeNull();

    app.applySettings({ ...app.settings, navWidth: 360 });
    await app.updateComplete;

    expect(app.querySelector(".sidebar-resizer")).toBeNull();
    const shell = app.querySelector<HTMLElement>(".shell");
    expect(shell?.style.getPropertyValue("--shell-nav-width")).toBe("");

    const split = app.querySelector(".chat-split-container");
    expect(split).not.toBeNull();
    if (split) {
      expect(getComputedStyle(split).position).not.toBe("fixed");
      split.classList.add("chat-split-container--open");
      await app.updateComplete;
      expect(split.classList.contains("chat-split-container--open")).toBe(true);
    }

    const chatMain = app.querySelector(".chat-main");
    expect(chatMain).not.toBeNull();
    if (chatMain) {
      expect(getComputedStyle(chatMain).display).not.toBe("none");
    }

    const topShell = app.querySelector<HTMLElement>(".topnav-shell");
    const content = app.querySelector<HTMLElement>(".topnav-shell__content");
    expect(topShell).not.toBeNull();
    expect(content).not.toBeNull();
    if (!topShell || !content) {
      return;
    }

    expect(topShell.classList.contains("topnav-shell")).toBe(true);
    expect(content.classList.contains("topnav-shell__content")).toBe(true);
    expect(topShell.querySelector(".topbar-nav-toggle")).not.toBeNull();
    expect(topShell.children[1]).toBe(content);
    expect(topShell.querySelector(".topnav-shell__actions")).not.toBeNull();

    const toggle = app.querySelector<HTMLElement>(".topbar-nav-toggle");
    const actions = app.querySelector<HTMLElement>(".topnav-shell__actions");
    expect(toggle).not.toBeNull();
    expect(actions).not.toBeNull();
    if (!toggle || !actions || !shell) {
      return;
    }

    expect(toggle.classList.contains("topbar-nav-toggle")).toBe(true);
    expect(actions.classList.contains("topnav-shell__actions")).toBe(true);
    expect(topShell.firstElementChild).toBe(toggle);
    expect(topShell.querySelector(".topbar-nav-toggle")).toBe(toggle);
    expect(actions.querySelector(".topbar-search")).not.toBeNull();
    expect(toggle.getAttribute("aria-label")).toBeTruthy();

    const nav = app.querySelector<HTMLElement>(".shell-nav");
    expect(nav).not.toBeNull();
    if (!nav) {
      return;
    }

    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(false);
    toggle.click();
    await app.updateComplete;

    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(true);
    expect(nav.classList.contains("shell-nav")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/channels"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(shell.classList.contains("shell--nav-drawer-open")).toBe(false);

    app.applySettings({ ...app.settings, navCollapsed: true });
    await app.updateComplete;

    expect(app.querySelector(".nav-section__label")).toBeNull();
    expect(app.querySelector(".sidebar-brand__logo")).toBeNull();

    expect(app.querySelector(".sidebar-shell__footer")).not.toBeNull();
    expect(app.querySelector(".sidebar-utility-link")).not.toBeNull();

    const item = app.querySelector<HTMLElement>(".sidebar .nav-item");
    const header = app.querySelector<HTMLElement>(".sidebar-shell__header");
    const sidebar = app.querySelector<HTMLElement>(".sidebar");
    expect(item).not.toBeNull();
    expect(header).not.toBeNull();
    expect(sidebar).not.toBeNull();
    if (!item || !header || !sidebar) {
      return;
    }

    expect(sidebar.classList.contains("sidebar--collapsed")).toBe(true);
    expect(item.querySelector(".nav-item__icon")).not.toBeNull();
    expect(item.querySelector(".nav-item__text")).toBeNull();
    expect(app.querySelector(".sidebar-brand__copy")).toBeNull();
    expect(header.querySelector(".nav-collapse-toggle")).not.toBeNull();
  });

  it("preserves the active session when opening chat from sidebar navigation", async () => {
    const app = mountApp("/sessions?session=agent:main:subagent:task-123");
    await app.updateComplete;

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/chat"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect(app.sessionKey).toBe("agent:main:subagent:task-123");
    expect(window.location.pathname).toBe("/chat");
    expect(window.location.search).toBe("?session=agent%3Amain%3Asubagent%3Atask-123");
  });

  it("keeps focus mode scoped to the chat tab", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    const shell = app.querySelector(".shell");
    expect(shell).not.toBeNull();
    expect(shell?.classList.contains("shell--chat-focus")).toBe(false);

    const toggle = app.querySelector<HTMLButtonElement>('button[title^="Toggle focus mode"]');
    expect(toggle).not.toBeNull();
    toggle?.click();

    await app.updateComplete;
    expect(shell?.classList.contains("shell--chat-focus")).toBe(true);

    const link = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/channels"]');
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    await app.updateComplete;
    expect(app.tab).toBe("channels");
    expect(shell?.classList.contains("shell--chat-focus")).toBe(false);

    const chatLink = app.querySelector<HTMLAnchorElement>('a.nav-item[href="/chat"]');
    chatLink?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );

    await app.updateComplete;
    expect(app.tab).toBe("chat");
    expect(shell?.classList.contains("shell--chat-focus")).toBe(true);
  });

  it("shows one online status dot next to the sidebar version", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.hello = {
      ok: true,
      server: { version: "1.2.3" },
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const version = app.querySelector<HTMLElement>(".sidebar-version");
    const statusDot = app.querySelector<HTMLElement>(".sidebar-version__status");
    expect(version).not.toBeNull();
    expect(statusDot).not.toBeNull();
    expect(statusDot?.getAttribute("aria-label")).toContain("Online");
  });

  it("auto-scrolls chat history to the latest message", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    const app = mountApp("/chat");
    await app.updateComplete;

    const initialContainer: HTMLElement | null = app.querySelector(".chat-thread");
    expect(initialContainer).not.toBeNull();
    if (!initialContainer) {
      return;
    }
    initialContainer.style.maxHeight = "180px";
    initialContainer.style.overflow = "auto";
    let scrollTop = 0;
    Object.defineProperty(initialContainer, "clientHeight", {
      configurable: true,
      get: () => 180,
    });
    Object.defineProperty(initialContainer, "scrollHeight", {
      configurable: true,
      get: () => 2400,
    });
    Object.defineProperty(initialContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    initialContainer.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
      const top =
        typeof options === "number" ? (y ?? 0) : typeof options?.top === "number" ? options.top : 0;
      scrollTop = Math.max(0, Math.min(top, 2400 - 180));
    }) as typeof initialContainer.scrollTo;

    app.chatMessages = Array.from({ length: 3 }, (_, index) => ({
      role: "assistant",
      content: `Line ${index}`,
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
    let finalScrollTop = 0;
    Object.defineProperty(container, "clientHeight", {
      value: 180,
      configurable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      value: 960,
      configurable: true,
    });
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => finalScrollTop,
      set: (value: number) => {
        finalScrollTop = value;
      },
    });
    Object.defineProperty(container, "scrollTo", {
      configurable: true,
      value: ({ top }: { top: number }) => {
        finalScrollTop = top;
      },
    });
    const targetScrollTop = container.scrollHeight;
    expect(targetScrollTop).toBeGreaterThan(container.clientHeight);
    app.chatMessages = [
      ...app.chatMessages,
      {
        role: "assistant",
        content: "Line 3",
        timestamp: Date.now() + 3,
      },
    ];
    await app.updateComplete;
    for (let i = 0; i < 10; i++) {
      if (container.scrollTop === targetScrollTop) {
        break;
      }
      await nextFrame();
    }
    expect(container.scrollTop).toBe(targetScrollTop);
  });

  it("hydrates safe query params and strips unsafe credentials from the URL", async () => {
    const app = mountApp("/ui/overview?token=abc123&password=sekret");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    expect(app.password).toBe("");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.search).toBe("");
  });

  it("hydrates token from URL hash, strips it, and clears it after gateway changes", async () => {
    const app = mountApp("/ui/overview#token=abc123");
    await app.updateComplete;

    expect(app.settings.token).toBe("abc123");
    expect(JSON.parse(localStorage.getItem("openclaw.control.settings.v1") ?? "{}").token).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/ui/overview");
    expect(window.location.hash).toBe("");

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

    await confirmPendingGatewayChange(app);

    expectConfirmedGatewayChange(app);
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
