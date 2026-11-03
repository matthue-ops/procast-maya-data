# Device saves and cloud synchronization

The updated app saves committed records to IndexedDB on this device, and synchronizes online through revision-checked Supabase RPCs. Under Options, the Save on this device button retries local persistence; Sync now retries synchronization. Local edit dates use the device clock, while cloud save dates come from PostgreSQL. Both display the browser's timezone. Dates do not override revision checks.

## Manual deployment

1. Preserve the current Supabase `app_state` row and pending work on every device. Old app copies can write during startup: avoid reopening them merely to back up without blocking writes.
2. Close old tabs on all devices. Prepare `index.html` and `sync.js` for deployment together, served from the same directory. HTTPS is required outside localhost for safe browser storage and tab locking.
3. Run [01-sync-migration.sql](supabase/manual/01-sync-migration.sql) in Supabase SQL Editor as `postgres`, then run [02-verify-sync.sql](supabase/manual/02-verify-sync.sql). Expected permissions: read and sync allowed; direct and column writes denied. The migration is transactional and deliberately rejects reruns. If it fails, retain the full error rather than bypassing checks.
4. Deploy the updated app and reload every device. The old app cannot cloud-save after migration. Any existing legacy device copy is preserved as pending, with no invented base revision: choose the cloud copy or explicitly replace it after review. A clean device loads cloud data without writing.
5. Confirm the sync indicator before switching devices. Do not clear browser storage while there are pending records.

The SQL has been tested in isolated PostgreSQL 17 with synthetic data, including concurrent saves and compatibility rollback. It has not been executed or verified against the live Supabase project. No Edge Function or new secret is needed.

## Conflict and recovery behavior

A stale device cannot silently replace cloud data. Its local copy remains available. Use cloud version saves a local backup before loading cloud data. Replace cloud with this device asks for confirmation, archives both versions locally, and uses the freshly read revision; another intervening save will still cause a conflict. Replacement affects the entire dataset, including deletions.

Download device backup exports the current local envelope and committed state. Download preserved copies exports archived conflict versions. These recovery files contain personal data and are not the same format as the app's regular import JSON; retain them for recovery rather than importing them blindly. Archives are kept locally without automatic pruning. Browser storage can be cleared or reach quota, so downloaded backups remain useful.

A lost network response retains the exact pending request for reconciliation. Further edits remain pending while it is retried. Storage errors pause uploads and show a backup action. One writer tab per origin is permitted; close the other tab and reload if editing is paused. A different browser/device remains independent and is protected by database revisions.

Unsubmitted form inputs are not saved by the device button; finish Save Record first. Cloud refresh is deferred while a form is being edited. Committed offline work survives reload if the page assets are available, but this change does not install a service worker or guarantee reopening the app from scratch offline. CDN libraries also need connectivity. Clearing a browser's storage removes its local pending work and archives.

## Structural and database effects

`sync.js` owns persistence and cloud communication. The existing record, schema-field, aftersales, import/export, and reporting functions keep their behavior, with their existing save calls routed through the new module. Navigation, theme, and collapsed-view state do not make data newer. Existing renderer sorting is ignored when comparing records for edits. Save/import notices direct users to the actual sync indicator rather than claiming cloud success.

The database keeps the original `payload`. Migration adds `sync_revision`, a receipt table containing request metadata/fingerprints (not historical payload backups), and fixed-row read/save functions. Browser direct mutation privileges are removed so old upserts cannot bypass protection. The save function locks the row and compares revisions atomically. Receipts grow per successful save and currently have no pruning policy. Existing rows' timestamps are retained until a new save supplies a server timestamp.

Authentication is unchanged: this app still uses the existing public anon client configuration, and RLS on `app_state` remains as inspected. This change does not restrict database access to you. Owners, service-role writes, or other privileged database writers must coordinate changes and advance/invalidate revisions; the concurrency guarantee applies to the browser RPC path.

## Rollback

[03-emergency-rollback.sql](supabase/manual/03-emergency-rollback.sql) restores legacy permissions and revokes browser RPC access, without reverting payloads or deleting revision history. Back up first, coordinate all devices, and restore the previous app alongside it. This reintroduces stale overwrites. Do not simply re-enable synchronization afterward: legacy writes do not advance revisions, so a new cutover must invalidate old revisions and reconcile pending copies.

## Validation

Serve the repository locally with `python3 -m http.server 8000 --bind 127.0.0.1` and run `node tests/sync-browser.cjs` in an environment providing Playwright and `/usr/bin/chromium`. Browser tests intercept all external traffic and use simulated data, never live Supabase.

For SQL tests, use a disposable PostgreSQL database: run `tests/sync-database-bootstrap.sql`, the migration, then `tests/sync-database.sql` with `psql -v ON_ERROR_STOP=1`. Never run the bootstrap or write tests against production. The bootstrap creates the synthetic roles/table expected by the migration.

## Device names and compact controls

Sync now and the save status stay visible. Open Options for manual local saving, backup downloads, and the device name. The name defaults to My Phone or My PC; set it once to a recognizable name such as Field Phone or Office PC. Names are remembered in this browser, so a different browser or site origin must be named separately. Renaming alone does not upload data or advance the revision.

Each new data save includes `_syncSource.deviceName` in the existing JSON payload, atomically with that save. Last cloud update displays the source name beside the database save time; it describes the whole dataset, not individual records. Existing saves without this metadata display Unknown device. Older frontend versions can still sync safely but omit this optional label when they save. Device names are descriptive labels, not proof of identity or authentication. In-flight requests retain the original label when retried, even if this browser is renamed afterward.

No additional SQL or schema migration is needed for this update. The existing revision, receipt, and RPC behavior remains in place. To roll back this interface update, redeploy the previous revision-protected frontend; do not run the emergency SQL rollback merely to remove device labels. The optional metadata can remain in the payload without changing record content or the revision guard. Back up data before deployment as usual.
