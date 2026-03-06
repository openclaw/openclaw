import { describe, it, expect, vi, beforeEach } from "vitest";

// Track notifications created
const notifications: Array<{
  title: string;
  options: NotificationOptions;
  instance: MockNotification;
}> = [];
const closeSpy = vi.fn();

class MockNotification {
  private listeners: Record<string, Array<() => void>> = {};
  constructor(
    public title: string,
    public options: NotificationOptions = {},
  ) {
    notifications.push({ title, options, instance: this });
  }
  close = closeSpy;
  addEventListener(event: string, fn: () => void) {
    (this.listeners[event] ??= []).push(fn);
  }
  dispatchClick() {
    for (const fn of this.listeners["click"] ?? []) {
      fn();
    }
  }
  static permission = "granted";
  static requestPermission = vi.fn().mockResolvedValue("granted");
}
// @ts-expect-error — mock
globalThis.Notification = MockNotification;

let visibilityState = "hidden";
if (typeof globalThis.document === "undefined") {
  // @ts-expect-error — partial mock
  globalThis.document = {};
}
Object.defineProperty(globalThis.document, "visibilityState", {
  get: () => visibilityState,
  configurable: true,
});
if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — partial mock
  globalThis.window = globalThis;
}

import {
  notifyReplyComplete,
  setReplyNotificationsEnabled,
  isReplyNotificationsEnabled,
  requestNotificationPermission,
} from "./reply-notifications.ts";

describe("reply-notifications", () => {
  beforeEach(() => {
    notifications.length = 0;
    closeSpy.mockClear();
    visibilityState = "hidden";
    setReplyNotificationsEnabled(true);
    MockNotification.permission = "granted";
    MockNotification.requestPermission.mockReset().mockResolvedValue("granted");
    // Ensure Notification is present
    // @ts-expect-error — mock
    globalThis.Notification = MockNotification;
  });

  // ── isReplyNotificationsEnabled / setReplyNotificationsEnabled ──

  it("isReplyNotificationsEnabled returns true by default", () => {
    expect(isReplyNotificationsEnabled()).toBe(true);
  });

  it("isReplyNotificationsEnabled reflects setReplyNotificationsEnabled", () => {
    setReplyNotificationsEnabled(false);
    expect(isReplyNotificationsEnabled()).toBe(false);
    setReplyNotificationsEnabled(true);
    expect(isReplyNotificationsEnabled()).toBe(true);
  });

  // ── requestNotificationPermission ──

  it("requestNotificationPermission resolves true when already granted", async () => {
    MockNotification.permission = "granted";
    const result = await requestNotificationPermission();
    expect(result).toBe(true);
    // Should not call requestPermission when already granted
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("requestNotificationPermission resolves false when already denied", async () => {
    MockNotification.permission = "denied";
    const result = await requestNotificationPermission();
    expect(result).toBe(false);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("requestNotificationPermission prompts and returns true when user grants", async () => {
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValue("granted");
    const result = await requestNotificationPermission();
    expect(result).toBe(true);
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("requestNotificationPermission prompts and returns false when user denies", async () => {
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValue("denied");
    const result = await requestNotificationPermission();
    expect(result).toBe(false);
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("requestNotificationPermission returns false when Notification API unavailable", async () => {
    const saved = globalThis.Notification;
    // @ts-expect-error — removing mock
    delete globalThis.Notification;
    const result = await requestNotificationPermission();
    expect(result).toBe(false);
    globalThis.Notification = saved;
  });

  // ── notifyReplyComplete ──

  it("sends notification when tab is hidden and permission granted", () => {
    notifyReplyComplete("Hello there");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe("OpenClaw");
    expect(notifications[0].options.body).toBe("Hello there");
  });

  it("does not send when tab is visible", () => {
    visibilityState = "visible";
    notifyReplyComplete("Hello");
    expect(notifications).toHaveLength(0);
  });

  it("does not send when disabled", () => {
    setReplyNotificationsEnabled(false);
    notifyReplyComplete("Hello");
    expect(notifications).toHaveLength(0);
  });

  it("does not send when permission denied", () => {
    MockNotification.permission = "denied";
    notifyReplyComplete("Hello");
    expect(notifications).toHaveLength(0);
  });

  it("does not send when permission is default (not yet granted)", () => {
    MockNotification.permission = "default";
    notifyReplyComplete("Hello");
    expect(notifications).toHaveLength(0);
  });

  it("does not send when Notification API unavailable", () => {
    const saved = globalThis.Notification;
    // @ts-expect-error — removing mock
    delete globalThis.Notification;
    notifyReplyComplete("Hello");
    expect(notifications).toHaveLength(0);
    globalThis.Notification = saved;
  });

  it("truncates long messages to 120 chars", () => {
    const long = "A".repeat(200);
    notifyReplyComplete(long);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].options.body).toBe("A".repeat(120));
  });

  it("does not truncate messages at exactly 120 chars", () => {
    const exact = "B".repeat(120);
    notifyReplyComplete(exact);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].options.body).toBe(exact);
  });

  it("falls back to 'Reply ready' when no preview", () => {
    notifyReplyComplete();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].options.body).toBe("Reply ready");
  });

  it("falls back to 'Reply ready' for empty string preview", () => {
    notifyReplyComplete("");
    expect(notifications).toHaveLength(1);
    expect(notifications[0].options.body).toBe("Reply ready");
  });

  it("uses tag 'openclaw-reply' to replace previous notifications", () => {
    notifyReplyComplete("First");
    notifyReplyComplete("Second");
    expect(notifications).toHaveLength(2);
    expect(notifications[0].options.tag).toBe("openclaw-reply");
    expect(notifications[1].options.tag).toBe("openclaw-reply");
  });

  it("sets silent: false on notification options", () => {
    notifyReplyComplete("Hello");
    expect(notifications[0].options.silent).toBe(false);
  });

  it("auto-closes notification after 5 seconds", () => {
    vi.useFakeTimers();
    notifyReplyComplete("Hello");
    expect(closeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(closeSpy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("click listener focuses the window and closes the notification", () => {
    if (!("focus" in window)) {
      (window as unknown as Record<string, unknown>).focus = () => {};
    }
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    notifyReplyComplete("Hello");
    expect(notifications).toHaveLength(1);
    notifications[0].instance.dispatchClick();
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledOnce();
    focusSpy.mockRestore();
  });
});
