/* LexiLoop offline worker. Keep every URL relative to the worker scope so the
   same build works at a domain root or a GitHub Pages project subdirectory. */
"use strict";

const CACHE_PREFIX = "lexiloop-offline-";
const CACHE_VERSION = "2026-10-19-1";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const CORE_PATHS = [
  "./",
  "./index.html",
  "./styles.css",
  "./exercises.js",
  "./app.js",
  "./pwa.js",
  "./manifest.webmanifest",
  "./privacy.html",
  "./vocabulary.json",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

const scopedUrl = path => new URL(path, self.registration.scope).href;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Fetch one-by-one so a host with a small concurrent request limit does not
    // make the 3 MB vocabulary file compete with every other install request.
    // A failed install leaves the previously active cache and worker untouched.
    for (const path of CORE_PATHS) {
      const request = new Request(scopedUrl(path), { cache: "reload" });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`Precache failed (${response.status}): ${request.url}`);
      await cache.put(request, response);
    }
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function navigationResponse(request) {
  const cache = await caches.open(CACHE_NAME);
  const networkRequest = new Request(request, { cache: "no-cache" });

  try {
    const response = await Promise.race([
      fetch(networkRequest),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Network timeout")), 3500))
    ]);
    if (!response || !response.ok) throw new Error(`Navigation failed: ${response?.status || "offline"}`);
    await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true }))
      || (await cache.match(scopedUrl("./index.html")))
      || (await cache.match(scopedUrl("./")))
      || new Response("词脉暂时无法离线启动，请联网完整打开一次后重试。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
  }
}

async function cachedAssetResponse(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }

  event.respondWith(cachedAssetResponse(request));
});

