# Maps and independent Excel files

## Approved scope

Saved Records, Aftersales, List to Visit, and Map are separate tabs. Aftersales and List to Visit support multiple independent Excel datasets, their own field headers, search, marker filtering, editable fields, original export filenames, and all/current-view export. Default displays unmarked records; clicking the status filter cycles through the other statuses and intersects the search. Visit datasets use Not visited / Visited. These markers are separate from Saved Records' LAST VISIT dates.

Merging creates a NEW file and keeps every original. Only rows with exactly the same business field names and values collapse: case, spaces, blank versus absent fields, and differing values remain distinct. Column order is irrelevant. Markers and internal IDs are excluded from identity. The later server upload wins the duplicate marker, even if an older file's marker was edited later. Replacement uploads receive a new upload order. Offline files must sync before they can participate in a merge; the preview shows the priority. Concurrent source changes block a merge for review rather than merging stale contents. Within one uploaded file, later identical rows win.

Exports contain hidden status and field-presence metadata columns, not white-on-white text. Ordinary spreadsheet viewing hides them, but they are not secret. Reimport reads those columns to preserve markers and distinguish missing fields from empty cells. Removing the metadata externally loses that information. Exporting a filtered view and importing it as a replacement replaces the selected dataset with that subset, so confirm the preview carefully.

## Free map

The map uses locally bundled Leaflet 1.9.4 (BSD-2-Clause license in vendor/leaflet/LICENSE) and standard OpenStreetMap tiles. No Google Maps Platform key, paid SDK, subscription, geocoding or billing account is used. Existing decimal latitude/longitude values are read directly, including Google's copied `9.6447561998793, 123.85308298023159` format. Links and ambiguous coordinates are not automatically geocoded. Invalid coordinates are listed for correction; invalid/future dates are flagged.

Green defaults to 0–30 days, orange 31–60, red over 60, gray no date. Shared settings select existing coordinate/date fields and editable whole-day cutoffs. Ages and Visited today use the Philippine calendar. Date editing and Visited today change the existing Saved Record through its normal durable offline sync. Search, filters and opening the map do not mutate records. Pins cluster at wider zooms; the phone-friendly record list offers Open record, Visited today and Google Maps navigation. Navigation opens ordinary Google Maps links outside the app.

OpenStreetMap is a community service, not an unlimited hosted-map entitlement or SLA. See https://operations.osmfoundation.org/policies/tiles/ and https://www.openstreetmap.org/copyright . Attribution stays visible; use only normal interactive viewing, keep browser caching/referrers enabled, and do not bulk download or prefetch offline tiles. This update adds no paid fallback. Tiles need internet and providers can limit availability. Live tile delivery could not be verified from the restricted development network; browser checks used synthetic tiles with the real Leaflet library. Opening Map sends viewed tile areas and normal browser request metadata to the tile provider; navigation sends the destination to Google when clicked.

The app has no new service worker: keep it open for offline field entry. A fresh offline browser cannot reliably load uncached application assets, tiles, or Excel libraries. Saved local entries and pending uploads sync when connection returns. New-origin browser storage is separate; sync/back up the old origin before switching.

## Structural and integrity changes

Manual migration `supabase/manual/07-datasets-and-map.sql` requires migrations 01 and 04. It transactionally adds four tables: datasets (UUID identity, independent schema and rows, upload order, generation, revision and soft deletion), shared map settings/revision, idempotent request receipts, and private change history. A sequence orders uploads. The existing nonempty Aftersales snapshot is copied with its IDs, headers, markers and source filename; the original app_state payload stays intact. If legacy rows contain mixed source filenames, that one existing list uses the alphabetically first filename. Saved Records' storage and leaf-change sync remain in app_state.

The browser adds a separate IndexedDB cache and immutable durable outbox for datasets/settings. The top save indicator accounts for both sync engines. RPCs lock the workspace control row and apply batches atomically. Retries reuse request IDs; replacement generations prevent stale rows from reappearing. Marker edits update just one row. A merge verifies all source snapshots before accepting it. Conflicts preserve the pending action for backup/review; discarding it archives the action and optimistic snapshot locally. Soft-deleted datasets and private history remain available to the administrator; history/receipts need storage monitoring and currently have no automatic pruning.

The migration wraps the existing Saved Records RPC and rejects old Aftersales mutation operations after cutover. Old devices with unsynced Aftersales changes must be backed up and recovered deliberately, not assumed migrated. This prevents a legacy single-list client from overwriting multiple files. Authentication is unchanged: existing public RPC access remains; this feature does not make the app private or implement device approval/passkeys.

The existing main JSON import/export and device backup cover Saved Records and the preserved legacy payload, NOT the new independent files. Use each file's Excel export plus **File management & recovery → Download dataset backup** for all new datasets, map settings and pending actions. The JSON recovery envelope is for technical recovery, not an ordinary upload format; there is no automatic JSON restore screen. Keep both kinds of backup. Do not clear browser site data with pending changes.

## Coordinated rollout — manual approval required for SQL

1. Back up the live Supabase database and download both main-device and dataset recovery copies on every device. Export current Aftersales Excel with markers. Wait until all devices are online and saved; close old app tabs.
2. Review and explicitly approve migration 07 before running it yourself in Supabase SQL Editor. It is a one-time migration, not rerunnable. Any failure rolls back the transaction; keep error details and do not patch production ad hoc.
3. Run read-only `08-verify-datasets-and-map.sql`. Confirm initial file count/markers, unchanged Saved Records count, protected tables, workspace RPC enabled, and bypass disabled.
4. Deploy the feature commit through PR review to Cloudflare's configured production branch `deploy/cloudflare-pages` using `node scripts/build-pages.mjs`, output `dist`. The build now allowlists 20 public files, including local Leaflet assets; SQL, tests, and repository internals are excluded. Avoid promoting the frontend before SQL approval/cutover.
5. Refresh every device. Confirm the migrated file and record counts, test a marker and a date update across devices, then a small offline edit/reconnect. Confirm exports/reimports preserve markers. Keep backups until field validation is complete.

No live SQL, production deployment, or merge is included in development validation. A source branch push may generate a Cloudflare preview; opening it against the real backend is potentially mutating and must wait for coordinated migration.

## Rollback

Download all files and pending actions first. Review `09-rollback-datasets-and-map.sql` and get separate approval. Coordinate it with the pre-feature frontend: it disables new workspace RPCs and restores the original Saved Records/Aftersales v2 writer. New tables, datasets, settings, receipts, and history are retained. The old frontend will show the OLD Aftersales cutover snapshot; it cannot display new files automatically. Decide which exported dataset to recover explicitly. This is not a data restore. Do not rerun 07 or use 03/06 as shortcuts; returning to this feature needs a planned re-enable.

## Validation

Pure models and actual XLSX serialization: `node tests/map-and-workspace-models.cjs`, `node tests/aftersales-workbook.cjs`. Build isolation: `node tests/pages-build.mjs`.

Use PostgreSQL 17 in a disposable container named `maya-workspaces-test`, with no published DB ports, initialized with `tests/sync-database-bootstrap.sql`, migrations 01, 04, then 07. Set `MAYA_TEST_DATABASE` when using another synthetic database. Run `node tests/workspace-database.cjs`. For browser tests serve the checkout on localhost:8000, install Playwright/Chromium and xlsx-js-style 1.2.0 in the temporary paths in `tests/workspace-browser.cjs`, and generate `/tmp/maya-combined-test.css` with Tailwind 3.4.17 from index.html. The browser suite resets the disposable database using `tests/workspace-fixture.sql` and fixes the clock to 2026-11-06; run `node tests/workspace-browser.cjs`. External requests are intercepted, and RPCs target only the disposable DB. Old Aftersales browser tests target the pre-feature UI and do not validate this version.
