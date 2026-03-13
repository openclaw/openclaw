import type { GatewayBrowserClient } from "./gateway.ts";

export type WebPushState = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
};

const DEFAULT_STATE: WebPushState = {
  supported: false,
  permission: "unsupported",
  subscribed: false,
  loading: false,
};

export function detectWebPushState(): WebPushState {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  if (!supported) {
    return DEFAULT_STATE;
  }

  return {
    supported: true,
    permission: Notification.permission,
    subscribed: false,
    loading: false,
  };
}

/** Timeout (ms) for service-worker readiness. */
const SW_READY_TIMEOUT = 10_000;

/**
 * Await service-worker readiness with a timeout so callers don't hang
 * indefinitely when registration fails or sw.js is unreachable.
 */
function swReady(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Service worker not ready (timed out)")), SW_READY_TIMEOUT),
    ),
  ]);
}

/**
 * URL-safe base64 string to Uint8Array (for applicationServerKey).
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Check if the browser already has an active push subscription.
 */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await swReady();
  return await registration.pushManager.getSubscription();
}

/**
 * Subscribe to web push notifications.
 * Requests notification permission if not already granted, fetches VAPID key
 * from the gateway, subscribes with the PushManager, and registers with the
 * gateway.
 */
export async function subscribeToWebPush(
  client: GatewayBrowserClient,
): Promise<{ subscriptionId: string }> {
  // Request permission.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(`Notification permission ${permission}`);
  }

  // Get VAPID public key from gateway.
  const vapidRes = await client.request("push.web.vapidPublicKey", {});
  const vapidPublicKey = (vapidRes as { vapidPublicKey: string }).vapidPublicKey;
  if (!vapidPublicKey) {
    throw new Error("Failed to retrieve VAPID public key");
  }

  // Subscribe via PushManager.
  const registration = await swReady();
  const pushSubscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
  });

  const subJson = pushSubscription.toJSON();
  if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) {
    throw new Error("Invalid push subscription from browser");
  }

  // Register with gateway.
  const registerRes = await client.request("push.web.subscribe", {
    endpoint: subJson.endpoint,
    keys: {
      p256dh: subJson.keys.p256dh,
      auth: subJson.keys.auth,
    },
  });

  return registerRes as { subscriptionId: string };
}

/**
 * Unsubscribe from web push notifications.
 */
export async function unsubscribeFromWebPush(client: GatewayBrowserClient): Promise<void> {
  const registration = await swReady();
  const subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    // Notify gateway first.
    await client.request("push.web.unsubscribe", {
      endpoint: subscription.endpoint,
    });
    // Then unsubscribe locally.
    await subscription.unsubscribe();
  }
}

/**
 * Send a test web push notification via the gateway.
 */
export async function sendTestWebPush(
  client: GatewayBrowserClient,
  options?: { title?: string; body?: string },
): Promise<void> {
  await client.request("push.web.test", {
    title: options?.title,
    body: options?.body,
  });
}
