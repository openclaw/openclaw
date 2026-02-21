let enabled = true;

export function isReplyNotificationsEnabled(): boolean {
  return enabled;
}

export function setReplyNotificationsEnabled(value: boolean): void {
  enabled = value;
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) {
    return false;
  }
  if (Notification.permission === "granted") {
    return true;
  }
  if (Notification.permission === "denied") {
    return false;
  }
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function notifyReplyComplete(preview?: string): void {
  if (!enabled) {
    return;
  }
  if (!("Notification" in window)) {
    return;
  }
  if (Notification.permission !== "granted") {
    return;
  }
  if (document.visibilityState === "visible") {
    return;
  }

  const title = "OpenClaw";
  const body = preview?.slice(0, 120) || "Reply ready";

  const notification = new Notification(title, {
    body,
    tag: "openclaw-reply",
    silent: false,
  });

  setTimeout(() => notification.close(), 5000);

  notification.addEventListener("click", () => {
    window.focus();
    notification.close();
  });
}
