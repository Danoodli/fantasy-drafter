// Draft Cockpit service worker. Board JSON under /data/ is network-first so a
// new draft always sees the newest CI build, with the cache as the offline
// fallback. The app shell stays stale-while-revalidate so a refresh mid-draft
// with dead wifi still loads. Live polling is cross-origin and passes through.

const CACHE = "draft-cockpit-v2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // Board JSON and page navigations go to the network first: a fresh
      // deploy must reach the very next load, not the one after.
      if (url.pathname.startsWith("/data/") || event.request.mode === "navigate") {
        try {
          const res = await fetch(event.request);
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        } catch {
          return (await cache.match(event.request)) || Response.error();
        }
      }
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
