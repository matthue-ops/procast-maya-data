/* Emergency network-only rollback. Keep this URL served for returning devices.
   Wait for every Procast window to close; never force-reload unsaved work. */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("procast-shell-")) await caches.delete(name);
      // Deliberately do not touch IndexedDB/localStorage, claim clients or reload them.
      await self.registration.unregister();
    })(),
  );
});
