/* Independent durable outbox for datasets and shared map settings. */
window.createWorkspaceStore = async function ({ client, deviceName }) {
  const initial = {
    protocol: 3,
    revision: null,
    datasets: [],
    mapSettings: {
      greenDays: 30,
      orangeDays: 60,
      coordinateKey: "COORDINATES",
      visitKey: "LAST VISIT",
    },
  };
  let db,
    record = { base: initial, outbox: [], review: "", backups: [] },
    ready = false,
    durable = false,
    busy = false,
    offline = false,
    configuration = false;
  let version = 0,
    saved = -1,
    chain = Promise.resolve(),
    timer;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());
  function status() {
    if (!ready) return "Opening file storage…";
    if (!durable)
      return "Could not save files on this device — download a backup";
    if (record.review) return record.review;
    if (configuration)
      return "Workspace SQL upgrade required — local changes are preserved";
    if (!navigator.onLine || offline)
      return "Offline — file changes saved on this device";
    if (saved < version) return "Saving file changes on this device…";
    if (busy) return "Syncing files…";
    return record.outbox.length
      ? "File changes waiting to sync"
      : record.base.revision == null
        ? "Cloud files not loaded yet"
        : "All workspace changes saved to cloud";
  }
  function tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction("cache", mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () =>
        reject(t.error || Error("Device storage failed"));
      fn(t.objectStore("cache"), (x) => (result = x));
    });
  }
  async function persist() {
    const v = ++version,
      snapshot = structuredClone(record);
    try {
      await tx("readwrite", (s) => s.put(snapshot, "current"));
      saved = v;
      durable = true;
      return true;
    } catch {
      durable = false;
      return false;
    } finally {
      emit();
    }
  }
  async function call(name, args) {
    if (!client) throw Error("Cloud library unavailable");
    const controller = new AbortController();
    let timeout;
    try {
      const q = client.rpc(name, args);
      const response = await Promise.race([
        typeof q.abortSignal === "function"
          ? q.abortSignal(controller.signal)
          : q,
        new Promise(
          (_, reject) =>
            (timeout = setTimeout(() => {
              controller.abort();
              reject(Error("Connection timeout"));
            }, 12000)),
        ),
      ]);
      if (response.error) {
        if (["PGRST202", "42501"].includes(response.error.code))
          configuration = true;
        throw response.error;
      }
      return response.data;
    } finally {
      clearTimeout(timeout);
    }
  }
  function queue(fn) {
    chain = chain.then(fn).catch(() => {
      offline = true;
      emit();
    });
    return chain;
  }
  async function sync() {
    clearTimeout(timer);
    if (!ready || !durable || record.review || !navigator.onLine) {
      emit();
      timer = setTimeout(() => api.sync(), 12000);
      return;
    }
    busy = true;
    emit();
    try {
      const meta = await call("maya_workspace_status");
      if (meta?.protocol !== 3) {
        configuration = true;
        throw Error("Upgrade required");
      }
      configuration = false;
      offline = false;
      if (meta.revision !== record.base.revision) {
        const state = await call("maya_workspace_snapshot");
        if (state?.protocol !== 3 || !Array.isArray(state.datasets))
          throw Error("Invalid workspace");
        record.base = state;
        if (!(await persist())) return;
      }
      let count = 0;
      while (record.outbox.length && count++ < 30) {
        if (!(await persist())) return;
        const batch = structuredClone(record.outbox[0]);
        const result = await call("maya_workspace_apply", batch);
        if (result?.status === "review_required") {
          record.review = result.reason;
          await persist();
          return;
        }
        if (
          !["saved", "already_saved"].includes(result?.status) ||
          result.request_id !== batch.p_request_id ||
          result.state?.protocol !== 3
        )
          throw Error("Invalid acknowledgement");
        record.base = result.state;
        record.outbox.shift();
        if (!(await persist())) return;
      }
    } catch (error) {
      if (/^(22|P000)/.test(error?.code || "")) {
        record.review =
          "A file change was rejected. Preserve a backup and review it.";
        await persist();
      } else offline = true;
    } finally {
      busy = false;
      emit();
      timer = setTimeout(() => api.sync(), offline ? 15000 : 12000);
    }
  }
  const api = {
    state: () => window.MayaWorkspaceTools.replay(record.base, record.outbox),
    status,
    ready: () => ready,
    blocked: () => !!record.review,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    add(actions) {
      if (!ready) throw Error("File storage is not ready");
      record.outbox.push({
        p_request_id: crypto.randomUUID(),
        p_actions: structuredClone(actions),
        p_device_name: (deviceName() || "My device").slice(0, 40),
      });
      version++;
      emit();
      return persist().then((ok) => {
        if (ok) api.sync();
        return ok;
      });
    },
    sync: () => queue(sync),
    backup: () => structuredClone(record),
    async discardBlocked() {
      if (
        !record.review ||
        !confirm(
          "Preserve a recovery copy and discard only the blocked first action? Other pending changes remain.",
        )
      )
        return;
      const snapshot = api.state();
      record.backups.push({
        batch: record.outbox.shift(),
        state: snapshot,
        at: new Date().toISOString(),
      });
      record.review = "";
      if (await persist()) api.sync();
    },
    externalStatus: () =>
      !ready ||
      !durable ||
      record.review ||
      configuration ||
      offline ||
      busy ||
      record.outbox.length ||
      saved < version
        ? status()
        : null,
    pending: () => record.outbox.length,
  };
  try {
    let grant;
    const granted = new Promise((r) => (grant = r));
    if (!navigator.locks) throw Error("Use a current HTTPS browser");
    navigator.locks.request(
      "maya-workspace-writer",
      { ifAvailable: true },
      (lock) => {
        grant(!!lock);
        return lock ? new Promise(() => {}) : undefined;
      },
    );
    if (!(await granted)) throw Error("Another workspace tab is open");
    db = await new Promise((resolve, reject) => {
      const q = indexedDB.open("maya-workspaces", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("cache");
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    record =
      (await tx(
        "readonly",
        (s, done) =>
          (s.get("current").onsuccess = (e) => done(e.target.result)),
      )) || record;
    if (!(await persist())) throw Error("Device storage unavailable");
    ready = true;
    api.sync();
  } catch (error) {
    record.review = `${error.message}. File editing is paused.`;
  }
  window.addEventListener("online", () => {
    offline = false;
    api.sync();
  });
  window.addEventListener("offline", () => {
    offline = true;
    emit();
  });
  window.addEventListener("focus", () => api.sync());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) api.sync();
  });
  window.addEventListener("beforeunload", (e) => {
    if (ready && (!durable || saved < version)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  emit();
  return api;
};
