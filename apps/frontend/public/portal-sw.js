self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const fallback = {
    title: "Nuovo aggiornamento",
    body: "C'è una novita nel portale.",
    url: "/#/",
    tag: "portal-notification",
  };

  let payload = fallback;
  try {
    payload = event.data ? { ...fallback, ...event.data.json() } : fallback;
  } catch (_error) {
    payload = fallback;
  }

  const iconUrl = new URL("pwa-icon.svg", self.registration.scope).href;
  const targetUrl = new URL(payload.url || "/#/", self.registration.scope).href;

  event.waitUntil(
    self.registration.showNotification(payload.title || fallback.title, {
      body: payload.body || fallback.body,
      icon: iconUrl,
      badge: iconUrl,
      tag: payload.tag || fallback.tag,
      renotify: true,
      data: {
        ...(payload.data || {}),
        url: targetUrl,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || new URL("/#/", self.registration.scope).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ("focus" in client) {
          if ("navigate" in client) {
            void client.navigate(targetUrl);
          }
          return client.focus();
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }

      return undefined;
    }),
  );
});
