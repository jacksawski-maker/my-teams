const W = "https://my-teams-push.jacksawski.workers.dev";
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let t = "My Teams", b = "Schedule update";
    try { const m = await (await fetch(W + "/latest")).json(); if (m && m.title) { t = m.title; b = m.body; } } catch (_) {}
    await self.registration.showNotification(t, { body: b, icon: "icon-v9.png" });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow("./"));
});
