// Real app/Leaflet, synthetic RPCs and browser GPS; no live Supabase or tiles.
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  http = require("node:http"),
  path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
async function record(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const q = indexedDB.open("maya-device-sync");
        q.onerror = () => reject(q.error);
        q.onsuccess = () => {
          const db = q.result,
            tx = db.transaction("state"),
            get = tx.objectStore("state").get("current");
          get.onsuccess = () => {
            resolve(get.result);
            db.close();
          };
        };
      }),
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
  const original = "9.6447561998793, 123.85308298023159";
  const payload = {
    customFields: [
      { key: "COORDINATES", type: "text" },
      { key: "LAST VISIT", type: "date" },
      { key: "NOTES", type: "text" },
    ],
    establishments: [
      {
        id: "a",
        name: "Merchant A",
        details: {
          COORDINATES: original,
          "LAST VISIT": "2026-09-24",
          NOTES: "Keep notes",
        },
      },
      {
        id: "shared",
        name: "Shared address",
        details: {
          COORDINATES: original,
          "LAST VISIT": "2026-09-25",
          NOTES: "Other merchant",
        },
      },
      {
        id: "b",
        name: "Nearby merchant",
        details: {
          COORDINATES: "9.6447571998793, 123.85308398023159",
          "LAST VISIT": "2026-09-26",
        },
      },
      {
        id: "missing",
        name: "Missing coordinate merchant",
        details: { COORDINATES: "invalid", "LAST VISIT": "" },
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
      payload,
      updated_at: "2026-11-09T00:00:00Z",
      device_name: "Test PC",
    },
    offline = false;
  const workspace = {
    protocol: 3,
    revision: "0",
    fieldFiltersEnabled: true,
    datasets: [],
    mapSettings: {
      greenDays: 30,
      orangeDays: 60,
      coordinateKey: "COORDINATES",
      visitKey: "LAST VISIT",
    },
  };
  const writes = [],
    receipts = new Map(),
    errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname === "/index.html") {
        res.writeHead(308, { Location: "/" });
        res.end();
        return;
      }
      const file = path.resolve(
        root,
        "dist",
        u.pathname === "/" ? "index.html" : u.pathname.slice(1),
      );
      if (!file.startsWith(path.join(root, "dist") + path.sep)) throw Error();
      const bytes = await fs.readFile(file);
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type":
          {
            ".js": "application/javascript",
            ".css": "text/css",
            ".html": "text/html",
            ".webmanifest": "application/manifest+json",
            ".png": "image/png",
            ".woff2": "font/woff2",
          }[path.extname(file)] || "text/plain",
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(() => {
      const watches = new Map();
      window.gpsHarness = {
        calls: 0,
        cleared: [],
        emit: (lat, lng, accuracy = 12, timestamp = Date.now()) => {
          for (const w of watches.values())
            w.ok({
              coords: { latitude: lat, longitude: lng, accuracy },
              timestamp,
            });
        },
        fail: (code) => {
          for (const w of [...watches.values()]) w.fail({ code });
        },
        active: () => watches.size,
      };
      Object.defineProperty(navigator, "geolocation", {
        value: {
          watchPosition(ok, fail) {
            const id = ++window.gpsHarness.calls;
            watches.set(id, { ok, fail });
            window.gpsHarness.lastSuccess = ok;
            return id;
          },
          clearWatch(id) {
            watches.delete(id);
            window.gpsHarness.cleared.push(id);
          },
        },
        configurable: true,
      });
    });
    const route = async (r) => {
      if (offline) return r.abort("internetdisconnected");
      const u = new URL(r.request().url());
      if (u.hostname === "tile.openstreetmap.org")
        return r.fulfill({ contentType: "image/png", body: png });
      if (!u.hostname.endsWith(".supabase.co")) return r.abort();
      const name = u.pathname.split("/").at(-1),
        args = r.request().postDataJSON() || {};
      let data;
      if (["maya_read_state", "maya_sync_status"].includes(name))
        data = structuredClone(main);
      else if (name === "maya_workspace_status")
        data = { protocol: 3, revision: workspace.revision };
      else if (name === "maya_workspace_snapshot") data = workspace;
      else if (receipts.has(args.p_request_id))
        data = { ...receipts.get(args.p_request_id), status: "already_saved" };
      else if (name === "maya_apply_changes") {
        writes.push(structuredClone(args));
        for (const a of args.p_changes) {
          assert.equal(a.kind, "update");
          assert.equal(a.collection, "establishments");
          const row = payload.establishments.find((x) => x.id === a.id);
          Object.assign(row.details, a.details_set);
          Object.assign(row, a.set);
        }
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
      } else throw Error("Unexpected write/RPC " + name);
      return r.fulfill({ json: data });
    };
    await context.route("https://**/*", route);
    const open = async () => {
      const p = await context.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(origin, { waitUntil: "domcontentloaded" });
      await p.waitForFunction(() => !document.getElementById("app").inert);
      return p;
    };
    let p = await open();
    await p.waitForFunction(() => !!navigator.serviceWorker.controller);
    await p.waitForFunction(
      () =>
        document.getElementById("sync-status").textContent ===
        "All changes saved to cloud",
    );
    assert.equal(
      await p.locator("#tab-collection").getAttribute("aria-pressed"),
      "true",
    );
    assert.deepEqual(
      await p
        .locator(".maya-tabs button")
        .evaluateAll((ns) => ns.map((n) => n.id)),
      ["tab-map", "tab-collection", "tab-aftersales", "tab-visits"],
    );
    await p.click("#tab-map");
    await p.waitForSelector(".leaflet-container");
    assert.equal(
      await p.locator(".map-record-list,.map-record-panel").count(),
      0,
    );
    assert.equal(await p.evaluate(() => gpsHarness.calls), 0);
    const search = p.getByRole("searchbox", {
      name: "Search map records",
      exact: true,
    });
    for (const width of [320, 390, 640]) {
      await p.setViewportSize({ width, height: 844 });
      const b = await p.locator("#maya-map-canvas").boundingBox(),
        nav = await p.locator(".maya-tabs").boundingBox();
      assert.equal(b.y, 0);
      assert.equal(b.width, width);
      assert.ok(Math.abs(b.height - nav.y) < 3);
      assert.equal(await p.locator(".app-header").isVisible(), false);
      assert.equal(await p.locator(".sync-panel").isVisible(), false);
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    await p.setViewportSize({ width: 390, height: 844 });
    await search.blur();
    assert.match(
      await search.evaluate((n) => getComputedStyle(n).backgroundColor),
      /rgba/,
    );
    await search.focus();
    assert.doesNotMatch(
      await search.evaluate((n) => getComputedStyle(n).backgroundColor),
      /rgba/,
    );
    await search.fill("Merchant");
    await search.blur();
    assert.doesNotMatch(
      await search.evaluate((n) => getComputedStyle(n).backgroundColor),
      /rgba/,
    );
    await search.fill("");
    await search.blur();
    async function menu() {
      if (
        (await p
          .getByRole("button", { name: "Map menu", exact: true })
          .getAttribute("aria-expanded")) !== "true"
      )
        await p.getByRole("button", { name: "Map menu", exact: true }).click();
    }
    await menu();
    assert.equal(
      await p
        .getByRole("combobox", { name: "Visit filter", exact: true })
        .inputValue(),
      "all",
    );
    await p
      .getByRole("button", { name: "Needs correction", exact: true })
      .click();
    assert.match(
      await p.getByRole("dialog").innerText(),
      /Missing coordinate merchant/,
    );
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "Open record", exact: true })
      .click();
    await p.waitForSelector("#view-details-modal:not(.hidden)");
    await p.locator('[data-action="close-view-modal"]').click();
    assert.equal(
      await p.locator("#tab-map").getAttribute("aria-pressed"),
      "true",
    );
    for (let z = 0; z < 8; z++) {
      const button = p.locator(".leaflet-control-zoom-in");
      if ((await button.getAttribute("class")).includes("leaflet-disabled"))
        break;
      await button.click();
      await p.waitForTimeout(280);
    }
    assert.equal(await p.locator(".map-cluster").innerText(), "2");
    await p.locator(".map-cluster").click();
    await p.waitForFunction(
      () => document.querySelectorAll(".leaflet-popup-content").length === 1,
    );
    const group = p
      .locator(".map-overlap-list > div")
      .filter({ has: p.getByText("Merchant A", { exact: true }) });
    await group
      .getByRole("button", { name: "Move location", exact: true })
      .click();
    assert.equal(await p.locator(".map-move-marker").count(), 1);
    assert.equal(writes.length, 0);
    await p.getByRole("button", { name: "Save location", exact: true }).click();
    await p.waitForFunction(
      () => document.querySelector(".map-move-panel").hidden,
    );
    assert.equal(writes.length, 0);
    assert.equal(payload.establishments[0].details.COORDINATES, original);
    assert.equal(
      (await record(p)).state.establishments[0].details.COORDINATES,
      original,
    );
    await p.locator(".map-cluster").click();
    await p.waitForFunction(
      () => document.querySelectorAll(".leaflet-popup-content").length === 1,
    );
    await p
      .locator(".map-overlap-list > div")
      .filter({ has: p.getByText("Merchant A", { exact: true }) })
      .getByRole("button", { name: "Move location", exact: true })
      .click();
    async function drag() {
      await p.waitForTimeout(400);
      const b = await p.locator(".map-move-marker").boundingBox();
      const cdp = await context.newCDPSession(p);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: b.x + 16, y: b.y + 14 }],
      });
      for (let i = 1; i <= 12; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { x: b.x + 16 + (37 * i) / 12, y: b.y + 14 + (28 * i) / 12 },
          ],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.detach();
    }
    await drag();
    assert.notEqual(
      await p.getByLabel("New coordinates").innerText(),
      "9.6447562, 123.853083",
    );
    assert.equal(writes.length, 0);
    p.once("dialog", (d) => d.dismiss());
    await p.click("#tab-collection");
    assert.equal(
      await p.locator("#tab-map").getAttribute("aria-pressed"),
      "true",
    );
    await p.getByRole("button", { name: "Cancel move", exact: true }).click();
    assert.equal(payload.establishments[0].details.COORDINATES, original);
    assert.equal(
      (await record(p)).state.establishments[0].details.COORDINATES,
      original,
    );
    console.log(
      "PASS phone viewport/menu/search, correction access, grouped merchant selection, real drag preview/cancel and unchanged default section",
    );
    async function popup(name) {
      await search.fill(name);
      await search.blur();
      await p
        .locator(".leaflet-overlay-pane path.leaflet-interactive")
        .first()
        .click();
      await p.waitForFunction(
        () => document.querySelectorAll(".leaflet-popup-content").length === 1,
      );
    }
    await popup("Merchant A");
    await p.getByRole("button", { name: "Open record", exact: true }).click();
    await p.waitForSelector("#view-details-modal:not(.hidden)");
    await p.locator('[data-action="close-view-modal"]').click();
    assert.equal(
      await p.locator("#tab-map").getAttribute("aria-pressed"),
      "true",
    );
    await popup("Merchant A");
    await p.getByRole("button", { name: "Move location", exact: true }).click();
    offline = true;
    await context.setOffline(true);
    await drag();
    const destination = await p.getByLabel("New coordinates").innerText();
    await p.getByRole("button", { name: "Save location", exact: true }).click();
    await until(
      async () => (await record(p)).outbox.length === 1,
      "offline coordinate queue",
    );
    assert.equal(writes.length, 0);
    const pending = await record(p),
      op = pending.outbox[0].p_changes[0];
    assert.deepEqual(op.details_set, { COORDINATES: destination });
    assert.deepEqual(op.set, {});
    assert.deepEqual(op.details_unset, []);
    assert.equal(op.id, "a");
    await p.close();
    p = await open();
    await p.click("#tab-map");
    await p.waitForSelector(".leaflet-container");
    assert.equal(
      (await record(p)).outbox[0].p_request_id,
      pending.outbox[0].p_request_id,
    );
    assert.equal(
      (await record(p)).state.establishments[0].details.COORDINATES,
      destination,
    );
    offline = false;
    await context.setOffline(false);
    await p.waitForFunction(
      () =>
        document.getElementById("sync-status").textContent ===
        "All changes saved to cloud",
    );
    assert.equal(writes.length, 1);
    assert.equal(payload.establishments[0].details.COORDINATES, destination);
    assert.equal(payload.establishments[0].details["LAST VISIT"], "2026-09-24");
    assert.equal(payload.establishments[0].details.NOTES, "Keep notes");
    assert.equal(payload.establishments[1].details.COORDINATES, original);
    console.log(
      "PASS coordinate-only offline Save, durable reload, automatic reconnect and unchanged visit/notes/coincident merchant",
    );
    const gpsLat = 17.1234567,
      gpsLng = 120.7654321;
    await menu();
    await p.getByRole("button", { name: "My location", exact: true }).click();
    assert.equal(await p.evaluate(() => gpsHarness.calls), 1);
    await p.evaluate(({ lat, lng }) => gpsHarness.emit(lat, lng), {
      lat: gpsLat,
      lng: gpsLng,
    });
    await p.waitForSelector(".map-my-location-dot");
    assert.match(
      await p.locator(".map-gps-status").innerText(),
      /accuracy about 12 m/,
    );
    assert.equal(writes.length, 1);
    assert.doesNotMatch(
      JSON.stringify(await record(p)),
      /17\.1234567|120\.7654321/,
    );
    await p.screenshot({ path: "/tmp/procast-phone-map.png" });
    await menu();
    await p
      .getByRole("button", { name: "Stop my location", exact: true })
      .click();
    assert.equal(await p.locator(".map-my-location-dot").count(), 0);
    assert.equal(await p.evaluate(() => gpsHarness.active()), 0);
    await menu();
    await p.getByRole("button", { name: "My location", exact: true }).click();
    await p.evaluate(() => gpsHarness.fail(1));
    assert.match(
      await p.locator(".map-gps-status").innerText(),
      /permission denied/,
    );
    assert.equal(await p.evaluate(() => gpsHarness.active()), 0);
    await menu();
    await p.getByRole("button", { name: "My location", exact: true }).click();
    await p.evaluate(() => gpsHarness.emit(17.1234567, 120.7654321));
    await p.click("#tab-collection");
    assert.equal(await p.evaluate(() => gpsHarness.active()), 0);
    assert.equal(await p.locator(".map-my-location-dot").count(), 0);
    await p.click("#tab-map");
    assert.equal(await p.evaluate(() => gpsHarness.calls), 3);
    await menu();
    await p.getByRole("button", { name: "My location", exact: true }).click();
    await p.evaluate(() => {
      gpsHarness.emit(17.1234567, 120.7654321);
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await p.evaluate(() => gpsHarness.active()), 0);
    assert.equal(await p.locator(".map-my-location-dot").count(), 0);
    await p.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await p.evaluate(() => gpsHarness.calls), 4);
    await menu();
    await p.getByRole("button", { name: "My location", exact: true }).click();
    await p.evaluate(() =>
      gpsHarness.emit(17.1234567, 120.7654321, 12, Date.now() - 60000),
    );
    assert.equal(await p.locator(".map-my-location-dot").count(), 0);
    assert.match(await p.locator(".map-gps-status").innerText(), /fresh/);
    await p.evaluate(() => {
      gpsHarness.emit(17.1234567, 120.7654321);
      gpsHarness.fail(3);
    });
    assert.match(await p.locator(".map-gps-status").innerText(), /timed out/);
    assert.equal(await p.evaluate(() => gpsHarness.active()), 0);
    await p.evaluate(() =>
      gpsHarness.lastSuccess({
        coords: { latitude: 17.1234567, longitude: 120.7654321, accuracy: 12 },
        timestamp: Date.now(),
      }),
    );
    assert.equal(await p.locator(".map-my-location-dot").count(), 0);
    await p.setViewportSize({ width: 1280, height: 844 });
    assert.equal(await p.locator(".app-header").isVisible(), true);
    assert.equal(await p.locator(".sync-panel").isVisible(), true);
    assert.equal(
      await p
        .getByRole("button", { name: "Map menu", exact: true })
        .isVisible(),
      false,
    );
    assert.equal(
      await p
        .getByRole("button", { name: "Map settings", exact: true })
        .isVisible(),
      true,
    );
    assert.equal(await p.locator(".app-header .maya-tabs").count(), 1);
    assert.deepEqual(
      await p
        .locator(".maya-tabs button")
        .evaluateAll((ns) => ns.map((n) => n.id)),
      ["tab-map", "tab-collection", "tab-aftersales", "tab-visits"],
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(errors, []);
    await context.close();
    // Also exercise the actual browser API with an emulated current location/permission.
    const real = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ["geolocation"],
      geolocation: {
        latitude: 17.1234567,
        longitude: 120.7654321,
        accuracy: 25,
      },
    });
    await real.route("https://**/*", route);
    const realPage = await real.newPage();
    await realPage.goto(origin, { waitUntil: "domcontentloaded" });
    await realPage.waitForFunction(() => !document.getElementById("app").inert);
    await realPage.click("#tab-map");
    await realPage.waitForSelector(".leaflet-container");
    await realPage
      .getByRole("button", { name: "Map menu", exact: true })
      .click();
    await realPage
      .getByRole("button", { name: "My location", exact: true })
      .click();
    await realPage.waitForFunction(() =>
      document.querySelector(".map-gps-status").textContent.includes("25 m"),
    );
    await realPage.waitForSelector(".map-my-location-dot");
    assert.match(await realPage.locator(".map-gps-status").innerText(), /25 m/);
    assert.equal(writes.length, 1);
    await realPage.click("#tab-collection");
    assert.equal(await realPage.locator(".map-my-location-dot").count(), 0);
    await real.close();
    console.log(
      "PASS permission-gated current GPS/accuracy, explicit stop, permission denial, leave/hidden cleanup, no history/writes, and unchanged desktop layout",
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
