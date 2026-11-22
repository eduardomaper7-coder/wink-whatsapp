/* Service worker de Wink · Mensajes
 * - Notificaciones push (mensajes en modo humano, derivaciones del asistente, avisos)
 * - Abre/enfoca la conversación al pulsar la notificación
 * - Página "sin conexión" para la navegación
 * No cachea datos de clientes: solo la página offline y los iconos.
 */
const CACHE = "wink-shell-v1";
const SHELL = ["/offline.html", "/icons/icon-192.png", "/icons/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Navegación: red primero; sin red → página offline
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Wink", body: event.data ? event.data.text() : "" };
  }
  const url = data.url || "/inbox";

  event.waitUntil(
    (async () => {
      if (typeof data.badge === "number" && "setAppBadge" in self.navigator) {
        try {
          await (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
        } catch {}
      }
      // Si la persona ya está mirando esa conversación, no molestar
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = windows.some((w) => w.focused && w.visibilityState === "visible" && new URL(w.url).pathname === url);
      if (watching && !data.urgent) return;

      await self.registration.showNotification(data.title || "Wink", {
        body: data.body || "",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        tag: data.tag || undefined,
        renotify: !!data.tag,
        requireInteraction: !!data.urgent,
        timestamp: data.timestamp || Date.now(),
        data: { url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/inbox";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ("navigate" in w) return w.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// El navegador renovó la suscripción: se registra la nueva
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(sub.toJSON()) });
    })(),
  );
});
