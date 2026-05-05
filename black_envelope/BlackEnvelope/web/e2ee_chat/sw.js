const CACHE_NAME = "blackenvelope-runtime-v14";
const STATIC_ASSETS = [
  "/",
  "/manifest.json",
  "/favicon.svg",
  "/favicon-32.png",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/ios-notifications-setting.png",
];

function isCacheableOkResponse(response) {
  return Boolean(
    response &&
      response.status === 200 &&
      (response.type === "basic" || response.type === "default")
  );
}

function isAppShellPathname(pathname) {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".html")
  );
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // Bypass HTTP cache for app-shell fetches so new deploys are picked up immediately.
    const networkRequest = new Request(request, { cache: "no-store" });
    const response = await fetch(networkRequest);
    if (isCacheableOkResponse(response)) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw _e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheableOkResponse(response)) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

// Install: pre-cache static media/icons
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: delete old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Allow page to force activation of waiting service worker
self.addEventListener("message", (event) => {
  if (event && event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Fetch: network-first for app shell so code updates land automatically,
// cache-first for static media/icons, passthrough for API/WS.
self.addEventListener("fetch", (event) => {
  if (!event.request || event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Never intercept API calls, WebSocket upgrades, or cross-origin requests
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/ws")) return;
  if (url.pathname === "/sw.js") return;

  if (event.request.mode === "navigate" || isAppShellPathname(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(cacheFirst(event.request));
});

// Push: show notification when app is in background
self.addEventListener("push", (event) => {
  let payload = { title: "BlackEnvelope", body: "New message" };
  try { payload = event.data.json(); } catch (_e) { /* use defaults */ }
  event.waitUntil(
    self.registration.showNotification(payload.title || "BlackEnvelope", {
      body: payload.body || "New message",
      icon: "/apple-touch-icon.png",
      badge: "/favicon-32.png",
      tag: "blackenvelope-message",
      renotify: true,
      data: { url: "/" },
    })
  );
});

// Notification click: focus existing tab or open new one
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow("/");
    })
  );
});
