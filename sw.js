/* Service worker — makes the app open with no network.
   Only the app shell is cached here. Your ledger data is cached separately
   by Firestore itself (IndexedDB), which is what lets you add entries
   offline and have them upload when you're back on. */

const VERSION = "paisa-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch Firestore/Auth traffic — it has its own offline machinery
  // and caching it would hand back stale data or break long-lived streams.
  if (/googleapis\.com|firebaseio\.com|firebaseapp\.com|identitytoolkit/.test(url.hostname)) return;

  // App shell and same-origin assets: cache first, refresh in the background.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // The Firebase SDK modules and fonts: cache once, then serve from cache
  // so a cold start works with no connection.
  if (/gstatic\.com|fonts\.googleapis\.com/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && (res.ok || res.type === "opaque")) {
          caches.open(VERSION).then(c => c.put(req, res.clone()));
        }
        return res;
      }).catch(() => hit))
    );
  }
});
