import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const build = (env) =>
  execFileSync(process.execPath, [path.join(root, "scripts/build-pages.mjs")], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
build({ PROCAST_PWA_ROLLBACK: "0" });
const worker = await readFile(
  path.join(root, "dist/service-worker.js"),
  "utf8",
);
const assets = JSON.parse(worker.match(/^const ASSETS = (.*);$/m)[1]);
assert.equal(assets.length, new Set(assets.map((a) => a.url)).size);
for (const a of assets) {
  assert.ok(a.url.startsWith("./"));
  assert.doesNotMatch(
    a.url,
    /supabase\.co|tile\.openstreetmap|supabase\/manual|AGENTS|docs\/|tests\/|service-worker\.js|_headers/,
  );
  const file = a.url === "./" ? "index.html" : a.url.slice(2);
  const bytes = await readFile(path.join(root, "dist", file));
  assert.equal(
    a.integrity,
    "sha256-" + createHash("sha256").update(bytes).digest("base64"),
  );
}
assert.ok(assets.find((a) => a.url === "./vendor/leaflet/leaflet.js"));
assert.ok(assets.find((a) => a.url === "./vendor/xlsx/xlsx.bundle.js"));
const html = await readFile(path.join(root, "dist/index.html"), "utf8");
for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
  assert.ok(match[1].startsWith("./"));
  assert.ok(assets.find((a) => a.url === match[1]));
}
assert.doesNotMatch(
  html,
  /cdn\.tailwindcss\.com|cdn\.jsdelivr\.net|fonts\.googleapis/,
);
const manifest = JSON.parse(
  await readFile(path.join(root, "dist/manifest.webmanifest"), "utf8"),
);
assert.equal(manifest.id, "./");
assert.equal(manifest.start_url, "./");
assert.equal(manifest.scope, "./");
assert.equal(manifest.display, "standalone");
for (const icon of manifest.icons) {
  const bytes = await readFile(path.join(root, "dist", icon.src));
  const [width, height] = icon.sizes.split("x").map(Number);
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
}
assert.ok(
  manifest.icons.find((i) => i.purpose === "maskable" && i.sizes === "512x512"),
);
console.log(
  "PASS local app assets, exact cache integrity manifest, standalone install metadata and actual PNG dimensions",
);
try {
  build({ PROCAST_PWA_ROLLBACK: "1" });
  const rollback = await readFile(
    path.join(root, "dist/service-worker.js"),
    "utf8",
  );
  assert.match(rollback, /registration\.unregister/);
  assert.doesNotMatch(
    rollback,
    /skipWaiting|deleteDatabase|localStorage\.clear/,
  );
  const html = await readFile(path.join(root, "dist/index.html"), "utf8");
  assert.doesNotMatch(html, /<script src="\.\/pwa\.js"/);
  assert.match(html, /Offline app setup is temporarily disabled/);
  console.log(
    "PASS coordinated network-only rollback artifact without record-store deletion or forced activation",
  );
} finally {
  build({ PROCAST_PWA_ROLLBACK: "0" });
}
