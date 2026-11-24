const CACHE_NAME = "zone-out-music-bg-v9";
const RUNTIME_CACHE = "zone-out-music-runtime-v9";
const MAX_RUNTIME_ENTRIES = 36;
const MAX_ENTRY_AGE_MS = 1000 * 60 * 60 * 6; // 6 hours self-clean TTL

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/app-bg.jpg",
  "/app-logo.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png"
];

async function fetchWithRetry(request, timeoutMs = 4500, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(request, {
        signal: controller.signal,
        cache: attempt === 0 ? "default" : "no-store"
      });
      clearTimeout(timer);
      if (response && response.ok) {
        return response;
      }
      lastError = new Error(`HTTP ${response ? response.status : "error"}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

async function selfCleanCaches() {
  const keys = await caches.keys();
  let purgedCount = 0;
  for (const key of keys) {
    if (key !== CACHE_NAME && key !== RUNTIME_CACHE) {
      await caches.delete(key);
      purgedCount++;
    }
  }
  const runtime = await caches.open(RUNTIME_CACHE);
  const requests = await runtime.keys();
  const now = Date.now();
  for (const req of requests) {
    const cachedResp = await runtime.match(req);
    if (!cachedResp) continue;
    const cachedAt = Number(cachedResp.headers.get("x-zo-cached-at") || 0);
    if (cachedAt && now - cachedAt > MAX_ENTRY_AGE_MS) {
      await runtime.delete(req);
      purgedCount++;
    }
  }
  const remaining = await runtime.keys();
  if (remaining.length > MAX_RUNTIME_ENTRIES) {
    const excess = remaining.slice(0, remaining.length - MAX_RUNTIME_ENTRIES);
    for (const oldReq of excess) {
      await runtime.delete(oldReq);
      purgedCount++;
    }
  }
  return purgedCount;
}

async function backgroundRefreshPulse(reason = "background") {
  const purged = await selfCleanCaches();
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS);
  } catch (_) {}

  const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of allClients) {
    client.postMessage({
      type: "BG_HEARTBEAT_ACK",
      reason,
      purged,
      timestamp: Date.now()
    });
  }
  return purged;
}

async function putStampedRuntime(request, response) {
  try {
    const runtime = await caches.open(RUNTIME_CACHE);
    const headers = new Headers(response.headers);
    headers.set("x-zo-cached-at", String(Date.now()));
    const body = await response.clone().arrayBuffer();
    const stamped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
    await runtime.put(request, stamped);
    await selfCleanCaches();
  } catch (_) {}
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(backgroundRefreshPulse("activate"));
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (!event.data) return;
  if (event.data.type === "SELF_CLEAN_NOW") {
    event.waitUntil(
      selfCleanCaches().then((purged) => {
        if (event.source && event.source.postMessage) {
          event.source.postMessage({ type: "SELF_CLEAN_DONE", purged, timestamp: Date.now() });
        }
      })
    );
  } else if (event.data.type === "BG_KEEPALIVE_PING") {
    event.waitUntil(backgroundRefreshPulse(event.data.reason || "keepalive"));
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetchWithRetry(event.request, 4500, 2)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetchWithRetry(event.request, 4500, 2)
        .then((response) => {
          putStampedRuntime(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

self.addEventListener("sync", (event) => {
  if (event.tag === "zone-out-link-pulse" || event.tag === "zone-out-bg-sync") {
    event.waitUntil(backgroundRefreshPulse("one-off-sync"));
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "zone-out-periodic-bg") {
    event.waitUntil(backgroundRefreshPulse("periodic-sync"));
  }
});

self.addEventListener("backgroundfetchsuccess", (event) => {
  event.waitUntil(backgroundRefreshPulse("background-fetch"));
});
