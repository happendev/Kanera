importScripts("./ngsw-worker.js");

// Keep these roles distinct: the notification icon is full-color, while the
// 96px badge is an alpha-only silhouette for Android to mask and tint.
const DEFAULT_ICON = new URL("/assets/favicon/android-chrome-192x192.png", self.location.origin).toString();
const DEFAULT_BADGE = new URL("/assets/favicon/notification-badge.png", self.location.origin).toString();

self.addEventListener("activate", (event) => {
  if (!self.registration.navigationPreload) return;

  // Angular's worker handles fetches after this wrapper imports it. Enabling
  // navigation preload lets the browser start document requests while the
  // service worker wakes up, without changing Kanera's cache strategy.
  event.waitUntil(self.registration.navigationPreload.enable());
});

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  const title = payload.title || "Kanera";
  const options = {
    body: payload.body || "",
    icon: payload.icon || DEFAULT_ICON,
    badge: payload.badge || DEFAULT_BADGE,
    tag: payload.tag,
    renotify: Boolean(payload.tag),
    data: {
      url: payload.url || "/",
      kind: payload.kind || "generic",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).toString();

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clientList) {
      if (new URL(client.url).toString() === targetUrl) {
        await client.focus();
        return;
      }
    }

    const opened = await self.clients.openWindow(targetUrl);
    if (opened) {
      await opened.focus();
      return;
    }

    // Some installed/mobile contexts decline openWindow from notificationclick.
    // As a fallback, reuse an existing Kanera window so the user still lands on
    // the card that triggered the push.
    for (const client of clientList) {
      if ("navigate" in client) {
        await client.navigate(targetUrl);
        await client.focus();
        return;
      }
    }
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const oldEndpoint = event.oldSubscription?.endpoint;
    let newSubscription = event.newSubscription;

    // If the browser didn't provide a new subscription, re-subscribe with the
    // same application server key from the old subscription.
    if (!newSubscription && event.oldSubscription) {
      try {
        newSubscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: event.oldSubscription.options?.applicationServerKey,
        });
      } catch {
        // Cannot re-subscribe — fall through to notify open windows.
      }
    }

    // Inform the server directly so the subscription row stays current even
    // when no app windows are open.
    if (oldEndpoint && newSubscription) {
      const json = newSubscription.toJSON();
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (p256dh && auth) {
        try {
          await fetch(new URL("/api/notifications/push/subscription-refresh", self.location.origin).toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              oldEndpoint,
              endpoint: newSubscription.endpoint,
              expirationTime: newSubscription.expirationTime ?? null,
              keys: { p256dh, auth },
            }),
          });
        } catch {
          // Network failure — fall through to notify open windows as fallback.
        }
      }
    }

    // Also notify any open windows so the UI can reflect the change.
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(clientList.map((client) => client.postMessage({ type: "kanera:pushsubscriptionchange" })));
  })());
});

function readPushPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json() || {};
  } catch {
    return { body: event.data.text() };
  }
}
