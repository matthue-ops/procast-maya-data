# Installable Procast (PWA)

## Install once, open from the app icon

No APK, Play Store listing, subscription, new SQL, login or Google Maps API is required. The installed application opens in a standalone window on supported phones and uses the same website and Supabase project.

After the PR is merged into Cloudflare's production branch and deployed:

1. On every existing device, let pending entries sync and download independent backups. Use both the Saved Records device backup and dataset recovery/Excel exports. Do not clear site data to install or refresh the app.
2. Open the actual production URL, https://procast-maya-data.pages.dev/, in normal Chrome (not incognito or an embedded chat browser) while online. Under **Options → Install Procast**, accept the installation prompt. If Chrome has not offered the prompt yet, use its menu → Add to home screen → Install. Availability and wording depend on the browser and Android version.
3. Wait for offline interface setup to complete, then open **Procast** from its app icon. It opens without browser tabs/address bar. Close the original browser tab before editing in the app: existing writer locks allow only one editing window per origin/profile.
4. Test offline reopening on the actual phone before field use. Confirm a record, visit/date edit, and Excel marker are retained, then reconnect with the app open and confirm both saving indicators settle. Maps show cached records/pins, but new map backgrounds and Google navigation require internet.

On iPhone, use Safari → Share → Add to Home Screen → Open as Web App (if offered) → Add. Installed iOS web apps and different browsers/profiles may have separate storage. Sync/back up the old browser first, launch the new app ONLINE once, and verify cloud data before relying on its offline copy. Android Chrome usually shares same-origin storage with its installed app in the same profile; this is not a cross-profile or cross-origin data-transfer mechanism.

Installation does not grant guaranteed permanent storage. Clearing site data, uninstalling, browser eviction, or switching origin/profile can remove or separate local copies. Continue keeping backups. Sync runs while the app is open and connectivity returns; this change does not add background sync after the app is closed, push notifications, or background location tracking. Close-to-reopen retains committed local entries; unfinished unsaved forms still need saving first.

## Application and integrity changes

- `manifest.webmanifest` declares a stable root ID/start URL/scope, standalone display, theme, name and original 192/512/maskable PNG icons; Apple touch metadata is included.
- `pwa.js` adds install/help under Options and an update bar only when a release is waiting. It checks every open Procast root/index window before an explicit update. Both sync engines expose read-only readiness checks. Pending outboxes, failed local writes, active uploads, review conflicts, and open record/settings/draft dialogs block forced reload. An unresponsive/older second window also blocks it. Successful checks temporarily freeze editing until the controller changes and reloads; failed checks restore the UI. Normal browser close/reopen can also activate a waiting release once all old windows are closed.
- The service worker caches only an explicit list of public shell files. Supabase RPCs/responses, records, uploaded spreadsheets, photos, map tiles, external links and arbitrary URLs are NOT added to this cache. Record data remains in the existing `maya-device-sync` and `maya-workspaces` IndexedDB databases; their schema/version and queue formats do not change.
- The page now loads local pinned Supabase JS **2.119.0** (the version resolved by the former `@2` CDN URL during implementation), xlsx-js-style **1.2.0**, generated Tailwind **3.4.17** CSS and Inter variable font **5.3.0** (latin subset, fallback fonts for other glyphs). Leaflet stays **1.9.4**. Fonts no longer need Google Fonts, and cold offline startup no longer depends on CDN scripts. Exact package versions, tarball integrity and source URLs are recorded in `vendor/offline-dependencies.json`; licenses ship with their libraries. No npm install is needed during Pages deployment.
- `scripts/build-pages.mjs` emits a worker with a content-derived release ID and SHA-256 integrity for every cached asset. Installation waits for the whole release and fails on missing/modified/mixed files, leaving the old shell usable. Pages' `/index.html` canonical redirect is handled by precaching `/` only and serving that cached shell for root/index navigations. Unknown paths continue to the server's normal 404 handling.
- Active pages keep their cached release until the guarded update or all windows close. Failed checks or partial deployments do not force a reload. Activation deletes only older `procast-shell-*` caches, never IndexedDB, localStorage or unrelated caches. Clearing app caches during a deliberate recovery must not be confused with clearing site data.

These changes add no database migrations, alter no business records, and change no authentication callbacks/environment secrets. Previously required SQL upgrades remain separate; a PWA install does not execute SQL. The public-role access model is unchanged.

## Build and update workflow

Cloudflare command/output stay **`node scripts/build-pages.mjs` → `dist`**. The explicit allowlist now publishes 36 files including icons, local libraries, manifest and generated worker; SQL, proposals, tests and repository metadata remain private. `_headers` supplies the manifest MIME type and disables HTTP caching of the worker; registration also uses `updateViaCache: 'none'`.

When changing `index.html` or Tailwind input, regenerate and commit the local stylesheet:

```sh
node scripts/compile-pwa-styles.mjs
```

This developer-only command runs the pinned Tailwind CLI via npx. An already installed CLI can be selected with `MAYA_TAILWIND_CLI=/path/to/tailwindcss/lib/cli.js`. The Pages build checks a source fingerprint and rejects stale CSS rather than publishing an incomplete offline UI. For new public runtime files, update the build allowlist; the worker manifest is generated automatically. Icons can be regenerated with `python3 scripts/generate-app-icons.py` (Pillow required for development only).

Do not apply edge transformations that change app-file bytes after this build (such as injected analytics scripts or HTML rewrites) without adapting the integrity build first: verification deliberately rejects transformed releases. Confirm actual Cloudflare deployment/phone install after promotion; outbound policy prevented direct production checks in development. Keep the same production origin; preview installations are separate apps/storage and should not be mistaken for production. Opening an unmocked preview may sync live data.

## Coordinated rollback without deleting records

A plain revert to a commit without a worker is insufficient: installed service workers may keep serving their cached app. Do not tell users to clear site data or uninstall with pending entries.

1. Preserve every device backup and let pending work sync if possible. Retain offline recovery envelopes if it cannot sync. Close or save unfinished forms.
2. Build/deploy the PWA commit with **`PROCAST_PWA_ROLLBACK=1 node scripts/build-pages.mjs`**. This replaces `/service-worker.js` with the network-only cleanup worker and disables registration/install UI in newly served HTML. It is a frontend deployment, not a SQL action.
3. Returning users connect, allow the worker update check, close ALL Procast windows, wait a moment and reopen ONLINE. The rollback worker deliberately waits for old windows to close before activating. It deletes only `procast-shell-*` caches and unregisters itself; record databases, local preferences, pending queues and unrelated caches are retained. This disables offline shell reopening until PWA support is restored; the existing app still runs online.
4. Keep serving the rollback worker at the same URL long enough for offline/returning devices to receive it. Do not delete that URL or force immediate activation. Remove the rollback flag in a later coordinated deployment to restore normal PWA setup. No database rollback is necessary for this feature.

## Validation

`node tests/pages-build.mjs` checks allowlist isolation and repeatability. `node tests/pwa-build.mjs` verifies cache asset hashes, local dependencies, standalone metadata, actual icon dimensions and rollback output (it restores the normal build afterward).

`node tests/pwa-browser.cjs` runs a real service worker in a temporary regular Chromium profile, a temporary HTTP server with Pages-style index redirects, local vendored libraries, and synthetic intercepted RPCs. It checks Chromium installability, install-button behavior, offline reopening with both outboxes pending and unchanged request IDs, offline map/Excel code, uncached data requests, rejection of a mixed release, pending/draft/other-window update blocks, an explicit safe reload, and rollback preserving records/unrelated caches. It does NOT install an app on a physical phone or validate live Supabase/tile delivery.

Existing workspace browser checks mock the new local Supabase script and disable workers for their isolated database suite; the PWA suite uses the real local client and worker. Pure change/Excel/map tests also pass. No live database writes or production deployment are part of these tests.
