/* Service worker minimal : met en cache la coquille de l'app pour un lancement
 * instantané et un fonctionnement même hors-ligne (l'UI ; les appels API ont
 * évidemment besoin du réseau). On ne touche jamais aux requêtes API. */
const CACHE = 'traducteur-v4';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Ne JAMAIS intercepter les appels API (Groq / Mistral / ElevenLabs) : toujours le réseau.
  if (url.origin !== self.location.origin) return;
  // Réseau d'abord (toujours la dernière version) ; le cache ne sert que de repli hors-ligne.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
