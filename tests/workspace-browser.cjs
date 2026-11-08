// Synthetic container only: this suite resets its fixture. External network traffic is intercepted.
const assert = require("node:assert/strict"),
  fs = require("node:fs");
const { chromium } = require("playwright"),
  DB = require("./workspace-db-helper.cjs");
const XLSX = require(process.env.MAYA_XLSX_MODULE || "/tmp/maya-excel-tests/node_modules/xlsx-js-style"),
  A = require("../aftersales-workbook.js");
(async () => {
  await DB.sql(
    fs.readFileSync(require.resolve("./workspace-fixture.sql"), "utf8"),
  );
  await DB.sql(
    `TRUNCATE public.maya_datasets,public.maya_workspace_receipts,public.maya_workspace_history; UPDATE public.maya_workspace_control SET revision=revision+1,map_settings='{"greenDays":30,"orangeDays":60,"coordinateKey":"COORDINATES","visitKey":"LAST VISIT"}';`,
  );
  const extraLocations = [
    {
      id: "same-location",
      name: "Shared address merchant",
      details: {
        COORDINATES: "9.6447561998793, 123.85308298023159",
        "LAST VISIT": "2026-09-24",
      },
    },
    {
      id: "near-location",
      name: "Nearby separate merchant",
      details: {
        COORDINATES: "9.6447571998793, 123.85308398023159",
        "LAST VISIT": "2026-09-24",
      },
    },
  ];
  await DB.sql(
    `UPDATE public.app_state SET payload=jsonb_set(payload,'{establishments}',(payload->'establishments') || ${DB.quote(JSON.stringify(extraLocations))}::jsonb) WHERE id='main_data';`,
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
      serviceWorkers: "block",
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
    const networkHandler = (r) => {
      const u = r.request().url();
      if (u.includes("tile.openstreetmap.org"))
        return r.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      return r.fulfill({ body: "" });
    };
    await c.route("https://**/*", networkHandler);
    await c.route("**/vendor/supabase/supabase.js", r => r.fulfill({contentType:"application/javascript",body:"window.supabase={createClient:()=>({rpc:(n,a)=>window.testRpc(n,a)})}"}));
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
    await host.locator(".phone-file-actions").click();
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
    await host.locator(".phone-file-actions").click();
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
    await p.evaluate(() => {
      window.copiedValue = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => (window.copiedValue = text) },
      });
    });
    await host.locator(".phone-record-name").first().click();
    let detail = p.getByRole("dialog");
    assert.equal(await detail.getByRole("textbox").count(), 0);
    await detail
      .getByRole("button", { name: "Copy Name", exact: true })
      .click();
    assert.equal(await p.evaluate(() => window.copiedValue), "Alpha");
    await detail
      .getByRole("button", { name: "Edit Name", exact: true })
      .click();
    await detail
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Cancelled");
    await detail.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await detail.getByRole("textbox").count(), 0);
    await detail
      .getByRole("button", { name: "Manage filters", exact: true })
      .click();
    await p.getByRole("button", { name: "Add filter", exact: true }).click();
    await p
      .getByRole("textbox", { name: "Filter name", exact: true })
      .fill("Merchant only");
    await p
      .getByRole("dialog")
      .getByText("Name", { exact: true })
      .locator("input")
      .check();
    await p.getByRole("button", { name: "Save filter", exact: true }).click();
    await p
      .getByRole("button", { name: "Back to record", exact: true })
      .click();
    await p
      .getByRole("combobox", { name: "Field filter", exact: true })
      .selectOption({ label: "Merchant only" });
    assert.equal(await p.locator(".workspace-read-field").count(), 1);
    assert.notEqual(await p.getByRole("dialog").getAttribute("data-dirty"),"true");
    await p.screenshot({path:"/tmp/workspace-fields-phone.png",fullPage:true});
    await p
      .getByRole("button", { name: "Copy filtered fields", exact: true })
      .click();
    assert.equal(await p.evaluate(() => window.copiedValue), "Name: Alpha");
    await p.getByRole("button", { name: "Edit Name", exact: true }).click();
    await p
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Alpha updated");
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await p.getByRole("button", { name: "Close", exact: true }).click();
    await saved();
    let workspace = await DB.rpc("maya_workspace_snapshot");
    const mergedFile = workspace.datasets.find(
      (d) => d.filename === "Merged Aftersales.xlsx",
    );
    assert.equal(Object.values(mergedFile.filters)[0].name, "Merchant only");
    assert.equal(
      mergedFile.records.find((r) => r.details.Name === "Alpha updated").details
        .Owner,
      "Tester",
    );
    assert.equal(
      Object.keys(
        workspace.datasets.find((d) => d.filename === "Browser New.xlsx")
          .filters,
      ).length,
      0,
    );
    console.log(
      "PASS read-only fields, tap-to-copy, explicit pencil editing/cancel, filtered copying and per-file saved filters",
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
    await visits.locator(".phone-record-name").first().click();
    assert.equal(await p.getByRole("dialog").getByRole("textbox").count(), 0);
    assert.equal(
      await p
        .getByRole("combobox", { name: "Field filter", exact: true })
        .locator("option")
        .count(),
      1,
    );
    await p.getByRole("button", { name: "Close", exact: true }).click();
    offline = true;
    await p.evaluate(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await visits.locator(".phone-record-name").first().click();
    await p
      .getByRole("button", { name: "Manage filters", exact: true })
      .click();
    await p.getByRole("button", { name: "Add filter", exact: true }).click();
    await p
      .getByRole("textbox", { name: "Filter name", exact: true })
      .fill("Phone-only view");
    await p
      .getByRole("dialog")
      .getByText("Name", { exact: true })
      .locator("input")
      .check();
    await p.getByRole("button", { name: "Save filter", exact: true }).click();
    await p
      .getByRole("button", { name: "Back to record", exact: true })
      .click();
    await p
      .getByRole("combobox", { name: "Field filter", exact: true })
      .selectOption({ label: "Phone-only view" });
    await p.getByRole("button", { name: "Close", exact: true }).click();
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
    const c2 = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    });
    await c2.exposeBinding("testRpc", async (source, name, args) => ({
      data: await DB.rpc(name, args),
      error: null,
    }));
    await c2.route("https://**/*", networkHandler);
    await c2.route("**/vendor/supabase/supabase.js", r => r.fulfill({contentType:"application/javascript",body:"window.supabase={createClient:()=>({rpc:(n,a)=>window.testRpc(n,a)})}"}));
    const p2 = await c2.newPage();
    await p2.goto("http://127.0.0.1:8000/", { waitUntil: "domcontentloaded" });
    await p2.waitForFunction(
      () =>
        document.querySelector("#view-visits-container [data-workspace-status]")
          ?.textContent === "All workspace changes saved to cloud",
    );
    await p2.click("#tab-visits");
    await p2
      .locator('#view-visits-container [data-testid="dataset-status-filter"]')
      .click();
    await p2
      .locator("#view-visits-container .phone-record-name")
      .first()
      .click();
    assert.equal(
      await p2
        .getByRole("combobox", { name: "Field filter", exact: true })
        .locator("option")
        .filter({ hasText: "Phone-only view" })
        .count(),
      1,
    );
    assert.equal(
      await p2
        .getByRole("combobox", { name: "Field filter", exact: true })
        .inputValue(),
      "",
    );
    await c2.close();
    console.log(
      "PASS offline filter definition survives reload/reconnect and appears on another device with independent selection",
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
    for (let zoom = 0; zoom < 6; zoom++) {
      const button = p.locator(".leaflet-control-zoom-in");
      if ((await button.getAttribute("class")).includes("leaflet-disabled"))
        break;
      await button.click();
      await p.waitForTimeout(300);
    }
    assert.match(
      await p.locator(".leaflet-control-zoom-in").getAttribute("class"),
      /leaflet-disabled/,
    );
    assert.equal(
      await p.locator(".leaflet-overlay-pane path.leaflet-interactive").count(),
      1,
    );
    assert.equal(await p.locator(".map-cluster").count(), 1);
    assert.equal(await p.locator(".map-cluster").innerText(), "2");
    await p.locator(".map-cluster").click();
    assert.match(
      await p.locator(".leaflet-popup-content").innerText(),
      /Shared address merchant/,
    );
    await p.locator(".leaflet-popup-close-button").click();
    console.log(
      "PASS maximum zoom separates nearby coordinates and groups only exactly coincident merchants",
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
    assert.equal(
      await p.locator("#tab-map").getAttribute("aria-pressed"),
      "true",
    );
    await p.locator('[data-action="close-view-modal"]').click();
    assert.equal(await p.locator("#view-map-container").isVisible(), true);
    assert.equal(
      await p.locator("#tab-map").getAttribute("aria-pressed"),
      "true",
    );
    await p.setViewportSize({ width: 390, height: 844 });
    const nav = await p.locator(".maya-tabs").boundingBox();
    assert.ok(nav.y + nav.height >= 843);
    assert.ok(nav.height < 90);
    await p.click("#tab-visits");
    assert.equal(await visits.isVisible(), true);
    await p.click("#tab-map");
    await p.click("#tab-aftersales");
    await host
      .getByRole("combobox", { name: "Aftersales file", exact: true })
      .selectOption(mergedFile.id);
    await host.getByRole("searchbox").fill("No match");
    await host.locator(".phone-file-actions").click();
    let confirmation = "";
    p.once("dialog", async (d) => {
      confirmation = d.message();
      await d.accept();
    });
    await host
      .getByRole("button", { name: "Delete file", exact: true })
      .click();
    await saved();
    assert.match(confirmation, /Merged Aftersales.xlsx \(2 records\)/);
    workspace = await DB.rpc("maya_workspace_snapshot");
    assert.equal(
      workspace.datasets.some((d) => d.id === mergedFile.id),
      false,
    );
    assert.equal(
      workspace.datasets.some((d) => d.filename === "Browser New.xlsx"),
      true,
    );
    assert.equal(
      workspace.datasets.some((d) => d.kind === "visits"),
      true,
    );
    console.log(
      "PASS file deletion uses full selected-file count, independent of search, and preserves other datasets",
    );
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
