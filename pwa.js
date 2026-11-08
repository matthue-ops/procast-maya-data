/* Install/update UI. Record data stays in the existing durable sync engines. */
(() => {
  let canUpdate = () => false,
    registration,
    prompt,
    prepared = false,
    token,
    freezeTimer;
  const cancelled = new Set();
  const frozen = new Map();
  const $ = (id) => document.getElementById(id);
  const standalone = () =>
    matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  const installed = () => {
    $("pwa-install-btn").hidden = true;
    $("pwa-install-status").textContent = "Procast is running as an app.";
  };
  function unfreeze() {
    clearTimeout(freezeTimer);
    prepared = false;
    for (const [element, inert] of frozen) element.inert = inert;
    frozen.clear();
  }
  function freeze() {
    prepared = true;
    for (const element of [
      document.querySelector(".sync-panel"),
      $("app"),
    ].filter(Boolean)) {
      frozen.set(element, element.inert);
      element.inert = true;
    }
    // A failed updater must never leave the interface permanently locked.
    freezeTimer = setTimeout(unfreeze, 15000);
  }
  window.MayaPwa = {
    setReadiness(check) {
      canUpdate = check;
    },
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "PROCAST_CANCEL_UPDATE") {
        cancelled.add(event.data.token);
        if (token === event.data.token) unfreeze();
      }
      if (event.data?.type !== "PROCAST_PREPARE_UPDATE") return;
      token = event.data.token;
      let ready = false;
      try {
        ready = !prepared && !cancelled.has(token) && canUpdate() === true;
      } catch {}
      if (ready) freeze();
      event.ports[0]?.postMessage({ ready });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (prepared) {
        clearTimeout(freezeTimer);
        location.reload();
      }
    });
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    prompt = event;
    if ($("pwa-install-btn")) $("pwa-install-btn").hidden = standalone();
  });
  window.addEventListener("appinstalled", () => {
    prompt = null;
    $("pwa-install-btn").hidden = true;
    $("pwa-install-status").textContent =
      "Installed. Open Procast from its icon on your phone.";
  });
  document.addEventListener("DOMContentLoaded", async () => {
    if (standalone()) installed();
    $("pwa-install-btn").addEventListener("click", async () => {
      if (prompt) {
        const offer = prompt;
        prompt = null;
        try {
          await offer.prompt();
          const result = await offer.userChoice;
          $("pwa-install-status").textContent =
            result.outcome === "accepted"
              ? "Installation requested. Open Procast from its app icon."
              : "You can install later using your browser menu.";
        } catch {
          $("pwa-install-status").textContent =
            "Use your browser menu to install Procast.";
        }
      } else {
        $("pwa-install-status").textContent = /iPad|iPhone|iPod/.test(
          navigator.userAgent,
        )
          ? "In Safari: Share → Add to Home Screen → Open as Web App → Add."
          : "Open this site in Chrome, then use its menu → Add to home screen → Install. Installation availability depends on your browser.";
      }
    });
    $("pwa-update-btn").addEventListener("click", () => {
      const waitingWorker = registration?.waiting;
      if (!waitingWorker) return;
      const button = $("pwa-update-btn");
      button.disabled = true;
      $("pwa-update-status").textContent =
        "Checking saved changes in all Procast windows…";
      const channel = new MessageChannel();
      const finish = (ok) => {
        clearTimeout(timeout);
        channel.port1.close();
        if (!ok) {
          unfreeze();
          button.disabled = false;
          $("pwa-update-status").textContent =
            "Finish or cancel open forms and wait for all changes to save. Close other Procast windows, then try again.";
        } else $("pwa-update-status").textContent = "Updating the app…";
      };
      const timeout = setTimeout(() => finish(false), 10000);
      channel.port1.onmessage = (event) => finish(event.data?.ok === true);
      try {
        waitingWorker.postMessage({ type: "PROCAST_REQUEST_UPDATE" }, [
          channel.port2,
        ]);
      } catch {
        finish(false);
      }
    });
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      $("pwa-install-status").textContent =
        "Open Procast in a current browser over HTTPS to install it.";
      return;
    }
    function waiting() {
      $("pwa-update-panel").hidden = !(registration.active && registration.waiting);
    }
    try {
      registration = await navigator.serviceWorker.register(
        "./service-worker.js",
        { scope: "./", updateViaCache: "none" },
      );
      waiting();
      const observed = new WeakSet();
      function offlineReady() {
        if (registration.waiting) return;
        $("pwa-install-status").textContent = standalone()
          ? "Procast is running as an app. Offline interface ready."
          : "Offline interface ready. Install Procast to open it from its own app icon.";
      }
      function watch() {
        const worker = registration.installing;
        if (!worker || observed.has(worker)) return;
        observed.add(worker);
        worker.addEventListener("statechange", () => {
          if (["installed", "activated"].includes(worker.state)) waiting();
          if (worker.state === "activated") offlineReady();
          if (worker.state === "redundant" && !registration.waiting)
            $("pwa-install-status").textContent = registration.active
              ? "App update could not download. The current offline version is still available."
              : "Offline setup did not complete. Reconnect and reopen Procast; device entries are unchanged.";
        });
      }
      registration.addEventListener("updatefound", watch);
      watch();
      if (registration.active) offlineReady();
      window.addEventListener("online", () =>
        registration.update().catch(() => {}),
      );
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && navigator.onLine)
          registration.update().catch(() => {});
      });
    } catch {
      $("pwa-install-status").textContent =
        "Offline setup is unavailable. Reconnect and reopen Procast; device entries are unchanged.";
    }
  });
})();
