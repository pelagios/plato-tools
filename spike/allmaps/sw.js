// Spike: a Service Worker as the hard block. Every request to another origin is sent with
// redirect: 'manual', and a redirect is refused rather than followed. It reports each request it
// sees to the page, so that the spike can tell whether the Allmaps worker pool's tile requests
// pass through it at all.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
async function tell(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) return;
  event.respondWith((async () => {
    tell({ seen: event.request.url, destination: event.request.destination, mode: event.request.mode });
    const r = await fetch(new Request(event.request, { redirect: 'manual' }));
    if (r.type === 'opaqueredirect') {
      tell({ refusedRedirect: event.request.url });
      return Response.error();
    }
    return r;
  })());
});
