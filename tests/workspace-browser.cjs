// Synthetic container only: this suite resets its fixture. External network traffic is intercepted.
const assert = require("node:assert/strict"),
  fs = require("node:fs");
const { chromium } = require("playwright"),
  DB = require("./workspace-db-helper.cjs");
const XLSX = require("/tmp/maya-excel-tests/node_modules/xlsx-js-style"),
  A = require("../aftersales-workbook.js");
const css = fs.readFileSync("/tmp/maya-combined-test.css", "utf8"),
  bundle = fs.readFileSync(
    "/tmp/maya-excel-tests/node_modules/xlsx-js-style/dist/xlsx.bundle.js",
    "utf8",
  );
(async () => {
  await DB.sql(
    fs.readFileSync(require.resolve("./workspace-fixture.sql"), "utf8"),
  );
  await DB.sql(
    `TRUNCATE public.maya_datasets,public.maya_workspace_receipts,public.maya_workspace_history; UPDATE public.maya_workspace_control SET revision=revision+1,map_settings='{"greenDays":30,"orangeDays":60,"coordinateKey":"COORDINATES","visitKey":"LAST VISIT"}';`,
  );
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const errors = [],
    calls = [];
  let offline = false;
  try {
    const c = await browser.newContext({
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
    });
    await c.exposeBinding("testRpc", async (source, name, args) => {
      calls.push(name);
      if (offline) return { error: { message: "Offline" } };
      try {
        return { data: await DB.rpc(name, args), error: null };
      } catch (e) {
        return { error: { message: e.message, code: "P0001" } };
      }
    });
    await c.route("https://**/*", (r) => {
      const u = r.request().url();
      if (u.includes("supabase-js"))
        return r.fulfill({
          contentType: "application/javascript",
          body: "window.supabase={createClient:()=>({rpc:(n,a)=>window.testRpc(n,a)})}",
        });
      if (u.includes("tailwind"))
        return r.fulfill({
          contentType: "application/javascript",
          body: `document.head.insertAdjacentHTML('beforeend','<style>'+${JSON.stringify(css)}+'</style>')`,
        });
      if (u.includes("xlsx-js-style"))
        return r.fulfill({
          contentType: "application/javascript",
          body: bundle,
        });
      if (u.includes("tile.openstreetmap.org"))
        return r.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      return r.fulfill({ body: "" });
    });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.clock.install({ time: new Date("2026-11-06T02:00:00Z") });
    await p.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#dataset-aftersales select", {
      state: "attached",
    });
    const host = p.locator("#dataset-aftersales"),
      visits = p.locator("#view-visits-container");
    async function saved() {
      await p.waitForFunction(
        () =>
          document.querySelector("[data-workspace-status]")?.textContent ===
          "All workspace changes saved to cloud",
        null,
        { timeout: 20000 },
      );
    }
    await saved();
    await p.click("#tab-aftersales");
    const book = A.makeWorkbook(
      XLSX,
      ["Name", "Owner"],
      [
        { details: { Name: "Alpha", Owner: "Tester" }, status: "None" },
        { details: { Name: "Beta", Owner: "Other" }, status: "Resolved" },
      ],
      { preserveFields: true },
    );
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
    await host.locator("input[type=file]").setInputFiles([
      {
        name: "Browser Old.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer,
      },
      {
        name: "Browser New.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer,
      },
    ]);
    await p
      .getByRole("button", { name: "Confirm upload", exact: true })
      .click();
    await saved();
    assert.equal(await host.locator(".workspace-card").count(), 1);
    await host.getByRole("button", { name: "Resolved", exact: true }).click();
    await saved();
    assert.equal(await host.locator(".workspace-card").count(), 0);
    await host.getByTestId("dataset-status-filter").click();
    await host.getByRole("searchbox").fill("Alpha");
    assert.equal(await host.locator(".workspace-card").count(), 1);
    const n = calls.filter((n) => n === "maya_workspace_apply").length;
    await host.getByTestId("dataset-status-filter").click();
    await host.getByTestId("dataset-status-filter").click();
    assert.equal(calls.filter((n) => n === "maya_workspace_apply").length, n);
    await host.getByRole("searchbox").fill("");
    await host
      .getByRole("button", { name: "Merge files", exact: true })
      .click();
    const d = p.getByRole("dialog");
    await d
      .getByText("Browser Old.xlsx", { exact: true })
      .locator("input")
      .check();
    await d
      .getByText("Browser New.xlsx", { exact: true })
      .locator("input")
      .check();
    assert.match(
      await d.getByTestId("merge-preview").innerText(),
      /4 source rows → 2 unique rows/,
    );
    await d
      .getByRole("button", { name: "Create merged file", exact: true })
      .click();
    await saved();
    assert.equal(await host.locator(".workspace-card").count(), 1); // New FILE has unmarked Alpha
    await host
      .locator("summary")
      .filter({ hasText: /^Export$/ })
      .click();
    const downloaded = p.waitForEvent("download");
    await host.getByRole("button", { name: "Export all", exact: true }).click();
    const out = await downloaded;
    assert.equal(out.suggestedFilename(), "Merged Aftersales.xlsx");
    const wb = XLSX.read(fs.readFileSync(await out.path()), {
      type: "buffer",
      cellStyles: true,
    });
    assert.equal(
      A.parseSheet(XLSX, wb.Sheets[wb.SheetNames[0]], { preserveFields: true })
        .rows.length,
      2,
    );
    console.log(
      "PASS browser multiple uploads, independent markers, search/status, newer-file merge priority, and real Excel download",
    );
    await p.click("#tab-visits");
    await visits.locator("input[type=file]").setInputFiles({
      name: "Visits.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: XLSX.write(
        XLSX.utils.book_new
          ? (() => {
              const b = XLSX.utils.book_new();
              XLSX.utils.book_append_sheet(
                b,
                XLSX.utils.aoa_to_sheet([["Name"], ["Visit Alpha"]]),
                "Data",
              );
              return b;
            })()
          : null,
        { type: "buffer", bookType: "xlsx" },
      ),
    });
    await p
      .getByRole("button", { name: "Confirm upload", exact: true })
      .click();
    await saved();
    offline = true;
    await p.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await visits.getByRole("button", { name: "Visited", exact: true }).click();
    await p.waitForFunction(() =>
      document
        .querySelector("#view-visits-container [data-workspace-status]")
        .textContent.includes("Offline"),
    );
    await visits.getByTestId("dataset-status-filter").click();
    assert.equal(await visits.locator(".workspace-card").count(), 1);
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.click("#tab-visits");
    await visits.getByTestId("dataset-status-filter").click();
    assert.equal(await visits.locator(".workspace-card").count(), 1);
    offline = false;
    await p.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => true,
      });
      window.dispatchEvent(new Event("online"));
    });
    await saved();
    console.log(
      "PASS visited markers survive offline reload and sync automatically after reconnection",
    );
    await p.click("#tab-map");
    await p.waitForSelector(".leaflet-container");
    await p.waitForSelector(".map-record");
    assert.match(
      await p.locator(".leaflet-control-attribution").innerText(),
      /OpenStreetMap/,
    );
    assert.equal(
      await p
        .locator(".leaflet-control-attribution")
        .evaluate((n) => getComputedStyle(n).color),
      "rgb(17, 17, 17)",
    );
    const merchant = p
      .locator(".map-record")
      .filter({ hasText: "Map Merchant" });
    assert.equal(await merchant.count(), 1);
    assert.match(await merchant.innerText(), /43 days/);
    assert.match(
      await merchant.getByRole("link").getAttribute("href"),
      /google.com\/maps\/dir/,
    );
    const before = await DB.rpc("maya_read_state");
    await merchant
      .getByRole("button", { name: "Visited today", exact: true })
      .click();
    await p.waitForFunction(
      () =>
        document.getElementById("sync-status").textContent ===
        "All changes saved to cloud",
      null,
      { timeout: 20000 },
    );
    const after = await DB.rpc("maya_read_state");
    const old = before.payload.establishments.find((r) => r.id === "m1"),
      now = after.payload.establishments.find((r) => r.id === "m1");
    assert.equal(now.details.COORDINATES, old.details.COORDINATES);
    assert.equal(now.details["LAST VISIT"], "2026-11-06");
    await p.getByRole("button", { name: "Map settings", exact: true }).click();
    await p.getByRole("spinbutton", { name: "Green cutoff days" }).fill("15");
    await p.getByRole("button", { name: "Save settings", exact: true }).click();
    await saved();
    assert.equal(
      (await DB.rpc("maya_workspace_snapshot")).mapSettings.greenDays,
      15,
    );
    for (const width of [320, 390, 1280]) {
      await p.setViewportSize({ width, height: 844 });
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `Map overflow at ${width}`,
      );
    }
    await p.setViewportSize({ width: 390, height: 844 });
    await p.screenshot({ path: "/tmp/maya-map-mobile.png", fullPage: true });
    await p.click("#tab-aftersales");
    for (const width of [320, 390, 1280]) {
      await p.setViewportSize({ width, height: 844 });
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `Dataset overflow at ${width}`,
      );
    }
    await p.click("#tab-map");
    await p
      .locator(".map-record")
      .filter({ hasText: "Map Merchant" })
      .getByRole("button", { name: "Open record", exact: true })
      .click();
    await p.waitForSelector("#view-details-modal:not(.hidden)");
    assert.deepEqual(errors, []);
    console.log(
      "PASS Leaflet map, attribution, Google navigation, scoped date update, shared thresholds, and mobile layouts",
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
