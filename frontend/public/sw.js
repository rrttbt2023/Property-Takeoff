const APP_SHELL_CACHE = "pt-app-shell-v1";
const RUNTIME_CACHE = "pt-runtime-v1";
const TILE_CACHE = "pt-tiles-v1";
const APP_SHELL_URLS = ["/", "/index.html", "/logo.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_URLS)).catch(() => null)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if ([APP_SHELL_CACHE, RUNTIME_CACHE, TILE_CACHE].includes(key)) return Promise.resolve();
          return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const tileLikeRequest =
    request.destination === "image" &&
    (url.pathname.includes("/tile") ||
      url.pathname.includes("/tiles") ||
      url.hostname.includes("maptiler") ||
      url.hostname.includes("mapbox") ||
      url.hostname.includes("google") ||
      url.hostname.includes("atlas.microsoft.com"));

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put("/index.html", copy)).catch(() => null);
          return response;
        })
        .catch(async () => {
          const cached = await caches.match("/index.html");
          return cached || Response.error();
        })
    );
    return;
  }

  if (tileLikeRequest) {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        if (cached) return cached;
        try {
          const response = await fetch(request, { mode: "cors" });
          const copy = response.clone();
          caches.open(TILE_CACHE).then((cache) => cache.put(request, copy)).catch(() => null);
          return response;
        } catch {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  if (sameOrigin) {
    event.respondWith(
      caches.match(request).then(async (cached) => {
        try {
          const response = await fetch(request);
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => null);
          return response;
        } catch {
          return cached || Response.error();
        }
      })
    );
  }
});
