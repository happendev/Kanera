importScripts("./ngsw-worker.js");

const SHARE_TARGET_CACHE = "kanera-share-target-v1";
const SHARE_TARGET_PATH = "/share-target";
const SHARE_PAYLOAD_PATH = "/share-target-payload/";

// Chrome delivers an installed PWA share target as a navigation POST. Angular's service worker
// deliberately bypasses this action (see the manifest's ngsw-bypass query), allowing this wrapper
// to keep long or sensitive shared text out of the URL and carry it safely through login/offline
// startup. The page consumes and deletes the one-time cached payload after launch.
self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "POST" || requestUrl.origin !== self.location.origin || requestUrl.pathname !== SHARE_TARGET_PATH) return;

  event.respondWith((async () => {
    const form = await event.request.formData();
    const payload = {
      title: clippedFormValue(form, "title", 2_000),
      text: clippedFormValue(form, "text", 100_000),
      url: clippedFormValue(form, "url", 8_192),
    };

    try {
      const cache = await caches.open(SHARE_TARGET_CACHE);
      const key = crypto.randomUUID();
      const payloadUrl = new URL(`${SHARE_PAYLOAD_PATH}${key}`, self.location.origin).toString();
      await cache.put(payloadUrl, new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }));

      // Shares abandoned before the app reads them should not grow this private cache forever.
      const stored = await cache.keys();
      await Promise.all(stored.slice(0, -20).map((request) => cache.delete(request)));
      return Response.redirect(new URL(`/share-target?shareKey=${encodeURIComponent(key)}`, self.location.origin), 303);
    } catch {
      // Cache Storage is expected for an installed PWA, but a bounded query fallback is still
      // preferable to dropping the user's share if storage is unavailable or full.
      const fallback = new URL(SHARE_TARGET_PATH, self.location.origin);
      if (payload.title) fallback.searchParams.set("title", payload.title.slice(0, 500));
      if (payload.text) fallback.searchParams.set("text", payload.text.slice(0, 4_000));
      if (payload.url) fallback.searchParams.set("url", payload.url.slice(0, 2_000));
      return Response.redirect(fallback, 303);
    }
  })());
});

function clippedFormValue(form, name, maxLength) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

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
