# Field filters, phone navigation and map refinements

## Behavior

Phones use one-tap bottom navigation (Records, Aftersales, Visits, Map). The desktop tabs remain at the top. The fixed bar reserves bottom/safe-area space; dialogs remain above it. Both Excel workspaces keep their file selector, search, marker filter and compact cards visible. File actions contains Upload, Delete, Merge and Export; desktop shows those controls directly, with Delete beside Upload. Deletion confirms the complete selected filename/count, even when the search displays only a subset. Existing soft deletion, history and stale-generation protections remain in place.

Aftersales and List to Visit open read-only record details. Clicking a value copies its raw value with confirmation. A pencil enables only that field; Save queues one field patch through the existing durable outbox; Cancel makes no write. Copy all fields and Copy filtered fields are separate actions. Field filters affect detail viewing and copying only, never Excel exports, business rows, markers, search or status filters. Large values remain accessible inside details.

Each dataset has independent named field filters. Manage filters creates, renames, edits and deletes definitions. Definitions sync across devices, while the active selection is remembered locally per file. Replacement retains definitions; any referenced columns missing in the new headers are flagged for review and omitted from the view/copy. Uncheck missing columns when editing the filter. New uploads and merges start with empty filter collections. File deletion removes it from active lists; its metadata remains in the soft-deleted database row.

Maps cluster nearby points only below zoom 17. At zoom 17–19 (including maximum), only numerically identical parsed latitude/longitude pairs share a group. Nearby distinct coordinates get individual pins even when they overlap visually. Clicking a same-coordinate group lists each merchant. Opening a Saved Record from Map leaves Map as the active section; closing returns to the same map, search, filters, position and zoom. Existing Saved Record editing/date sync remains in use.

## Database integrity and manual cutover

The UI, read-only editing, deletion placement, navigation and clustering need no new schema. Synced field-filter definitions require **manual migration 10**, after migrations 01, 04 and 07. Do not rerun 07.

`10-dataset-field-filters.sql` transactionally adds a non-null JSON object column `maya_datasets.field_filters` with an empty default. It updates the existing snapshot/apply RPCs, retaining their grants, row locks, durable receipts, history and atomic batch rejection. Snapshot advertises `fieldFiltersEnabled`. The client disables filter management until that capability is present. The workspace revision increments so existing devices fetch the new metadata. No new tables, business field values, coordinates, visit dates, records or markers are changed.

Filter actions are generation scoped. Each carries a filter ID and its expected previous definition: stale edits to the same filter stop for review instead of silently overwriting another device. Independent filters can save independently. Validation requires a nonempty name, unique existing columns and valid IDs; snapshots/recovery backups include definitions. Replacement keeps filters without rewriting them, allowing missing-column review. Existing direct-table write restrictions remain; authentication is unchanged and this update does not make the app private.

1. Export current Excel files and download dataset/device recovery backups on **every** device. Let pending changes sync and close tabs. Retain backups because browser clearing/eviction can remove offline work.
2. Review and explicitly approve migration 10 before running it yourself in Supabase SQL Editor. The migration is one-time and transactional, with a short lock timeout. Any error rolls back its changes; preserve the error for investigation.
3. Run read-only `11-verify-dataset-field-filters.sql`. Compare record counts/markers against the backup. Initially every file should have `{}` filters; expect direct_write_allowed=false and rpc_enabled=true.
4. Review/merge the feature branch into the configured Cloudflare production branch, `deploy/cloudflare-pages`. Build command/output remain `node scripts/build-pages.mjs` and `dist`. No hosting secrets or auth callbacks change.
5. On phone and PC confirm single-tap navigation, read-only copying, pencil save/cancel, independent filters, cross-device definitions, offline reconnection, deletion filename/count, and Map return/zoom behavior. Keep backups through field testing.

No live database migration, production merge or deployment is part of development validation. A branch push may create a preview connected to the same Supabase database; testing that preview can write live data and must be coordinated.

## Rollback

`12-rollback-dataset-field-filters.sql` requires **separate approval** and a coordinated return to the pre-10 frontend. Download all definitions and pending queues first. It restores the pre-10 RPC bodies and advances the workspace revision. The new column, definitions, business rows, history and receipts remain intact, but old snapshots/UI do not expose filters. Pending filter actions cannot be accepted by the old RPC; keep their recovery files for technical recovery. It does not undo 07, restore historical rows, or delete data. Re-enabling later requires a planned RPC re-enable without rerunning the ADD COLUMN migration.

Filter selections use origin-local storage; inability to persist the selection does not alter records or server definitions. The app retains existing offline/cold-start limitations and public-role access. No paid map API is introduced.

## Validation

Use only a disposable PostgreSQL 17 container named `maya-workspaces-test` without published ports, initialized with `tests/sync-database-bootstrap.sql`, migrations 01/04/07/10. `node tests/dataset-filters-database.cjs` covers metadata isolation, validation, retry idempotence, stale conflicts, rename/delete, replacement retention and unchanged business rows. Existing workspace database tests exercise the earlier safeguards after the new RPC replacement.

`tests/workspace-browser.cjs` uses real Leaflet and XLSX libraries, intercepted external requests, and RPC bindings to the disposable DB. It resets synthetic fixtures and checks read-only copying/edit/cancel, per-file filters, offline filter/marker reload and two-browser reconnection, selected-file deletion, single-tap navigation, close-to-map behavior, maximum-zoom same-coordinate grouping and mobile widths. See the earlier maps-and-datasets guide for temporary library/CSS setup. Map tiles are synthetic during these tests; live provider delivery is not verified.
