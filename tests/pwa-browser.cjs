// Real service worker, local bundled dependencies and synthetic RPCs only.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http");
const { createHash } = require("node:crypto");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const hash = (bytes) =>
  "sha256-" + createHash("sha256").update(bytes).digest("base64");
async function idb(page, name, store) {
  return page.evaluate(
    ({ name, store }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction(store);
          const get = tx.objectStore(store).get("current");
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
          get.onerror = () => reject(get.error);
        };
      }),
    { name, store },
  );
}
async function until(fn, label) {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + label);
}
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "procast-pwa-"));
  const v1 = path.join(temp, "v1"),
    v2 = path.join(temp, "v2"),
    broken = path.join(temp, "broken");
  await fs.cp(path.join(root, "dist"), v1, { recursive: true });
  await fs.cp(v1, v2, { recursive: true });
  let html = await fs.readFile(path.join(v2, "index.html"), "utf8");
  html = html.replace(
    "</head>",
    '<meta name="pwa-test-release" content="v2"></head>',
  );
  await fs.writeFile(path.join(v2, "index.html"), html);
  let worker = await fs.readFile(path.join(v2, "service-worker.js"), "utf8");
  const assets = JSON.parse(worker.match(/^const ASSETS = (.*);$/m)[1]);
  for (const asset of assets)
    if (["./", "./index.html"].includes(asset.url))
      asset.integrity = hash(html);
  const release = createHash("sha256").update(html).digest("hex").slice(0, 24);
  worker = worker
    .replace(
      /^const RELEASE = .*;$/m,
      "const RELEASE = " + JSON.stringify(release) + ";",
    )
    .replace(
      /^const ASSETS = .*;$/m,
      "const ASSETS = " + JSON.stringify(assets) + ";",
    );
  await fs.writeFile(path.join(v2, "service-worker.js"), worker);
  await fs.cp(v2, broken, { recursive: true });
  await fs.appendFile(
    path.join(broken, "workspace-store.js"),
    "\n// simulated mixed deployment\n",
  );
  let directory = v1,
    online = true,
    holdWrites = false,
    mainWrites = 0,
    fileWrites = 0;
  const payload = {
    customFields: [
      { key: "COORDINATES", type: "text" },
      { key: "LAST VISIT", type: "date" },
    ],
    establishments: [
      {
        id: "m1",
        name: "PWA Offline Merchant",
        details: {
          COORDINATES: "9.644756, 123.853082",
          "LAST VISIT": "2026-01-01",
        },
      },
    ],
    savedFilters: [],
    aftersalesHeaders: [],
    aftersalesRecords: [],
  };
  let main = {
    protocol: 2,
    revision: "0",
    epoch: "0",
    aftersales_epoch: "0",
    updated_at: "2026-11-08T00:00:00Z",
    device_name: "Test device",
    payload,
  };
  let workspace = {
    protocol: 3,
    revision: "0",
    fieldFiltersEnabled: true,
    mapSettings: {
      greenDays: 30,
      orangeDays: 60,
      coordinateKey: "COORDINATES",
      visitKey: "LAST VISIT",
    },
    datasets: [
      {
        id: "d1",
        kind: "aftersales",
        name: "Offline file.xlsx",
        filename: "Offline file.xlsx",
        headers: ["Name"],
        records: [
          {
            id: "r1",
            details: { Name: "PWA Offline File Merchant" },
            status: "None",
          },
        ],
        filters: {},
        uploadOrder: "1",
        generation: "0",
        revision: "1",
      },
    ],
  };
  const receipts = new Map(),
    errors = [],
    requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      requests.push(url.pathname);
      if (url.pathname === "/private-data") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"private":"never cache"}');
        return;
      }
      if (url.pathname === "/index.html") { res.writeHead(308, {Location:"/"});res.end();return; }
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const full = path.resolve(directory, name);
      if (!full.startsWith(directory + path.sep)) throw Error("Invalid path");
      const content = await fs.readFile(full);
      const ext = path.extname(name);
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type":
          {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".webmanifest": "application/manifest+json",
            ".png": "image/png",
            ".woff2": "font/woff2",
          }[ext] || "text/plain",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const context = await chromium.launchPersistentContext(
    path.join(temp, "profile"),
    {
      viewport: { width: 390, height: 844 },
      executablePath: "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox"],
    },
  );
  try {
    await context.route("https://**/*", async (route) => {
      const u = new URL(route.request().url());
      if (!online) return route.abort("internetdisconnected");
      if (!u.hostname.endsWith(".supabase.co")) return route.abort();
      const name = u.pathname.split("/").at(-1),
        args = route.request().postDataJSON() || {};
      if (
        holdWrites &&
        ["maya_apply_changes", "maya_workspace_apply"].includes(name)
      )
        return route.fulfill({
          status: 503,
          json: { message: "Simulated offline writes" },
        });
      let data;
      if (["maya_read_state", "maya_sync_status"].includes(name))
        data = structuredClone(main);
      else if (name === "maya_workspace_status")
        data = { protocol: 3, revision: workspace.revision };
      else if (name === "maya_workspace_snapshot")
        data = structuredClone(workspace);
      else if (receipts.has(args.p_request_id))
        data = { ...receipts.get(args.p_request_id), status: "already_saved" };
      else if (name === "maya_apply_changes") {
        for (const change of args.p_changes) {
          assert.equal(change.kind, "update");
          const row = payload.establishments.find((r) => r.id === change.id);
          Object.assign(row.details, change.details_set);
          Object.assign(row, change.set);
        }
        mainWrites++;
        main.revision = String(Number(main.revision) + 1);
        data = {
          status: "saved",
          request_id: args.p_request_id,
          revision: main.revision,
          epoch: "0",
          aftersales_epoch: "0",
          saved_at: main.updated_at,
          device_name: args.p_device_name,
          skipped: [],
        };
        receipts.set(args.p_request_id, data);
      } else if (name === "maya_workspace_apply") {
        for (const a of args.p_actions) {
          assert.equal(a.kind, "set_marker");
          workspace.datasets
            .find((d) => d.id === a.id)
            .records.find((r) => r.id === a.recordId).status = a.status;
        }
        fileWrites++;
        workspace.revision = String(Number(workspace.revision) + 1);
        data = {
          status: "saved",
          request_id: args.p_request_id,
          state: structuredClone(workspace),
        };
        receipts.set(args.p_request_id, data);
      } else throw Error("Unexpected RPC " + name);
      return route.fulfill({ json: data });
    });
    const open = async () => {
      const p = await context.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(origin, { waitUntil: "domcontentloaded" });
      await p.waitForFunction(() => !document.getElementById("app").inert);
      return p;
    };
    let page = await open();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.waitForFunction(() => document.getElementById("pwa-update-panel").hidden);
    assert.equal(await page.locator("#pwa-update-panel").isVisible(),false);
    await until(
      async () =>
        !(await idb(page, "maya-device-sync", "state")).outbox.length &&
        (await idb(page, "maya-workspaces", "cache")).base.revision !== null,
      "initial cached snapshots",
    );
    await page.waitForFunction(
      () =>
        document.getElementById("sync-status").textContent ===
        "All changes saved to cloud",
    );
    const cdp = await context.newCDPSession(page);
    const app = await cdp.send("Page.getAppManifest");
    assert.deepEqual(app.errors, []);
    const manifest = JSON.parse(app.data);
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.name, "Procast");
    assert.equal(manifest.start_url, "./");
    const installErrors = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installErrors.installabilityErrors, []);
    assert.equal(
      await page.evaluate(() => typeof XLSX.utils.book_new),
      "function",
    );
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      return (
        await Promise.all(
          names.map(async (n) =>
            (await (await caches.open(n)).keys()).map((r) => r.url),
          ),
        )
      ).flat();
    });
    assert.ok(cached.some((u) => u.endsWith("/vendor/supabase/supabase.js")));
    assert.ok(cached.every((u) => u.startsWith(origin + "/")));
    assert.ok(
      cached.every(
        (u) =>
          !u.includes("supabase.co") && !u.includes("tile.openstreetmap.org"),
      ),
    );
    console.log(
      "PASS standalone manifest/icons and Chromium installability; all essential runtime dependencies bundled",
    );
    // Exercise browser install UI without claiming an OS installation in headless Chrome.
    await page.evaluate(() => {
      const e = new Event("beforeinstallprompt", { cancelable: true });
      e.prompt = async () => (window.installPromptShown = true);
      e.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(e);
    });
    await page.locator("#sync-options").evaluate((n) => (n.open = true));
    await page.click("#pwa-install-btn");
    await page.screenshot({path:"/tmp/procast-install-options.png"});
    assert.equal(await page.evaluate(() => window.installPromptShown), true);
    await page.locator("#sync-options").evaluate((n) => (n.open = false));
    await page.evaluate(() => fetch("/private-data"));
    assert.equal(
      await page.evaluate(async () => {
        for (const n of await caches.keys())
          if (await (await caches.open(n)).match("/private-data")) return true;
        return false;
      }),
      false,
    );
    online = false;
    await context.setOffline(true);
    await page.click("#tab-map");
    await page.waitForSelector(".leaflet-container");
    await page
      .locator(".map-record")
      .filter({ hasText: "PWA Offline Merchant" })
      .getByRole("button", { name: "Visited today", exact: true })
      .click();
    await page.click("#tab-aftersales");
    await page.locator("#dataset-aftersales [data-marker=Resolved]").click();
    await until(
      async () =>
        (await idb(page, "maya-device-sync", "state")).outbox.length === 1 &&
        (await idb(page, "maya-workspaces", "cache")).outbox.length === 1,
      "both offline outboxes durable",
    );
    const pendingMain = await idb(page, "maya-device-sync", "state"),
      pendingFiles = await idb(page, "maya-workspaces", "cache");
    await page.close();
    page = await open();
    assert.match(await page.locator("#sync-status").innerText(), /Offline/);
    assert.equal(
      (await idb(page, "maya-device-sync", "state")).outbox[0].p_request_id,
      pendingMain.outbox[0].p_request_id,
    );
    assert.equal(
      (await idb(page, "maya-workspaces", "cache")).outbox[0].p_request_id,
      pendingFiles.outbox[0].p_request_id,
    );
    assert.equal(
      await page.evaluate(() => typeof XLSX.utils.book_new),
      "function",
    );
    assert.equal(
      await page
        .locator(".maya-tabs")
        .evaluate((n) => getComputedStyle(n).position),
      "fixed",
    );
    await page.goto(origin+"/index.html",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>!document.getElementById("app").inert);
    await page.click("#tab-map");
    await page.waitForSelector(".leaflet-container");
    assert.match(
      await page.locator(".map-message").innerText(),
      /unavailable|internet/,
    );
    assert.equal(await page.evaluate(() => typeof L.circleMarker), "function");
    await page.screenshot({path:"/tmp/procast-offline-app.png"});
    assert.ok(
      (
        await page
          .locator(".map-record")
          .filter({ hasText: "PWA Offline Merchant" })
          .innerText()
      ).includes("Visited today"),
    );
    await assert.rejects(() => page.evaluate(() => fetch("/private-data")));
    console.log(
      "PASS complete offline reopening, local map/Excel code, and both pending outboxes retained without changing request IDs",
    );
    // A mixed deployment fails integrity checking and keeps the old working shell.
    await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      r.addEventListener("updatefound", () => {
        r.installing?.addEventListener(
          "statechange",
          (e) => (window.lastWorkerState = e.target.state),
        );
      });
    });
    directory = broken;
    online = true;
    holdWrites = true;
    await context.setOffline(false);
    await page.waitForFunction(() => window.lastWorkerState === "redundant");
    await page.waitForFunction(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return !r.installing && !r.waiting;
    });

    assert.equal(
      await page.evaluate(
        () => document.querySelector("meta[name=pwa-test-release]")?.content,
      ),
      undefined,
    );

    online = false;
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.getElementById("app").inert);
    assert.equal(
      await page.evaluate(
        () => document.querySelector("meta[name=pwa-test-release]")?.content,
      ),
      undefined,
    );
    assert.equal(
      (await idb(page, "maya-device-sync", "state")).outbox.length,
      1,
    );
    directory = v2;
    online = true;
    await context.setOffline(false);
    await page.waitForFunction(
      async () => !!(await navigator.serviceWorker.getRegistration()).waiting,
    );
    await page.waitForSelector("#pwa-update-panel:not([hidden])");
    await page.click("#pwa-update-btn");
    await page.waitForFunction(() =>
      document
        .getElementById("pwa-update-status")
        .textContent.includes("Finish or cancel"),
    );
    assert.equal(
      (await idb(page, "maya-device-sync", "state")).outbox.length,
      1,
    );
    assert.equal(
      (await idb(page, "maya-workspaces", "cache")).outbox.length,
      1,
    );
    assert.equal(
      await page.evaluate(
        () => document.querySelector("meta[name=pwa-test-release]")?.content,
      ),
      undefined,
    );
    console.log(
      "PASS mixed-release rejection and no forced update with pending main/file entries",
    );
    holdWrites = false;
    await page.click("#sync-now-btn");
    await page.waitForFunction(
      () =>
        document.getElementById("sync-status").textContent ===
        "All changes saved to cloud",
    );
    assert.equal(mainWrites, 1);
    assert.equal(fileWrites, 1);
    await page.click("#tab-collection");
    await page.click("#new-record-btn");
    await page
      .locator("#create-record-dialog input")
      .first()
      .fill("Unsaved draft");
    await page.evaluate(() =>
      document.getElementById("pwa-update-btn").click(),
    );
    await page.waitForFunction(
      () => !document.getElementById("pwa-update-btn").disabled,
    );
    assert.equal(
      await page.locator("#create-record-dialog input").first().inputValue(),
      "Unsaved draft",
    );
    assert.equal(
      await page.evaluate(
        () => document.querySelector("meta[name=pwa-test-release]")?.content,
      ),
      undefined,
    );
    await page.locator("#create-record-dialog input").first().fill("");
    await page.click("#close-create-record-btn");
    // A second Procast window cannot approve because existing writer locks protect it.
    const other = await context.newPage();
    await other.goto(origin, { waitUntil: "domcontentloaded" });
    await other.waitForFunction(
      () =>
        document.getElementById("app").inert &&
        document.getElementById("sync-status").textContent.includes("Another"),
    );
    await page.click("#pwa-update-btn");
    await page.waitForFunction(
      () => !document.getElementById("pwa-update-btn").disabled,
    );
    assert.equal(
      await page.evaluate(() => document.getElementById("app").inert),
      false,
    );
    await other.close();
    // Add an unrelated cache to prove activation only prunes its own app-shell caches.
    await page.evaluate(async () => {
      await (
        await caches.open("unrelated-user-cache")
      ).put("/sentinel", new Response("keep"));
    });
    await page.waitForTimeout(500);
    const reloaded = page.waitForEvent("domcontentloaded");
    await page.click("#pwa-update-btn");
    await reloaded;
    await page.waitForFunction(
      () =>
        document.querySelector("meta[name=pwa-test-release]")?.content ===
          "v2" && !document.getElementById("app").inert,
    );
    assert.equal(
      (await idb(page, "maya-device-sync", "state")).outbox.length,
      0,
    );
    assert.equal(
      (await idb(page, "maya-workspaces", "cache")).outbox.length,
      0,
    );
    assert.equal(mainWrites, 1);
    assert.equal(fileWrites, 1);
    assert.equal(
      (await page.evaluate(() => caches.keys())).filter((n) =>
        n.startsWith("procast-shell-"),
      ).length,
      1,
    );
    assert.ok(
      (await page.evaluate(() => caches.keys())).includes(
        "unrelated-user-cache",
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS draft/other-window protection, explicit guarded update/reload, unchanged record storage and unrelated cache preservation",
    );
    // Validate the documented administrator rollback: close all windows, preserve data.
    const rollback = path.join(temp, "rollback");
    await fs.cp(v2, rollback, { recursive: true });
    await fs.copyFile(
      path.join(root, "scripts/service-worker.rollback.js"),
      path.join(rollback, "service-worker.js"),
    );
    let rollbackHtml = await fs.readFile(
      path.join(rollback, "index.html"),
      "utf8",
    );
    rollbackHtml = rollbackHtml
      .replace('<script src="./pwa.js"></script>', "")
      .replace('content="v2"', 'content="rollback"');
    await fs.writeFile(path.join(rollback, "index.html"), rollbackHtml);
    directory = rollback;
    await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistration()).update(),
    );
    await page.waitForFunction(
      async () => !!(await navigator.serviceWorker.getRegistration()).waiting,
    );
    await page.close();
    await new Promise((r) => setTimeout(r, 500));
    page = await open();
    assert.equal(
      await page.evaluate(
        () => document.querySelector("meta[name=pwa-test-release]")?.content,
      ),
      "rollback",
    );
    assert.equal(
      await page.evaluate(
        async () => !!(await navigator.serviceWorker.getRegistration()),
      ),
      false,
    );
    assert.equal(
      (await idb(page, "maya-device-sync", "state")).state.establishments[0]
        .name,
      "PWA Offline Merchant",
    );
    assert.equal(
      (await idb(page, "maya-workspaces", "cache")).base.datasets[0].records[0]
        .status,
      "Resolved",
    );
    assert.equal(
      (await page.evaluate(() => caches.keys())).filter((n) =>
        n.startsWith("procast-shell-"),
      ).length,
      0,
    );
    assert.ok(
      (await page.evaluate(() => caches.keys())).includes(
        "unrelated-user-cache",
      ),
    );
    console.log(
      "PASS network-only rollback after windows close, with IndexedDB data and unrelated caches retained",
    );
    await context.close();
  } finally {
    await context.close();
    await new Promise((r) => server.close(r));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
