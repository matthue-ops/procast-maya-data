# Automatic synchronization and phone workflow

Completed records save automatically on the device, then the durable outbox sends only individual changes. Different records and fields combine. When two devices edit the same field, the last change accepted by PostgreSQL wins, including an offline edit received later. Device timestamps are informational, not a global edit-order clock.

## Upgrade the existing deployment

The initial revision migration (`01-sync-migration.sql`) is already installed in your project. **Do not rerun it.** This update requires a new manual SQL upgrade; no Edge Function or new secret is needed.

1. Preserve a database backup and pending copies from each device. Close old app tabs. Opening old versions can send pending work.
2. Prepare `index.html`, `sync.js`, and `sync-changes.js` for deployment together in the same directory over HTTPS.
3. Run `supabase/manual/04-automatic-merge.sql` as postgres in Supabase SQL Editor, then `05-verify-automatic-merge.sql`. The migration is transactional and intentionally rejects reruns/collisions. It validates existing IDs and payload shapes before committing. If it fails, keep the error; do not bypass validation.
4. Expected verification: protocol 2; read/merge/poll allowed for anon and authenticated; direct writes, legacy saves, and private history reads denied.
5. Deploy the matching frontend, then reload each device. Older revision-only frontends lose cloud-writing access at cutover, so minimize the gap between SQL and app deployment. Do not continue entering data in old tabs.
6. Clean existing device copies refresh automatically. A **previous-version pending copy** cannot be safely turned into field changes because its original field baseline was never stored. It is preserved with a one-time review prompt. Download its backup and review it before loading cloud data or explicitly replacing the dataset. Never choose a full replacement just to dismiss a message.

For a new test database only, install `01` before `04`. The legacy verification/rollback scripts `02` and `03` describe v1 and are not the v2 rollout steps.

## Simple statuses and controls

- **Saving on this device…**: the browser has not yet confirmed durable local storage.
- **Offline — changes saved on this device**: completed entries are locally stored; upload is pending or cloud connectivity is unavailable.
- **Syncing changes…**: checking or uploading. The app retries automatically on connection/focus and every 10–15 seconds; background mobile browser throttling may delay timers.
- **All changes saved to cloud**: every pending batch has a database acknowledgement. It does not mean an unfinished form has been saved or that other offline devices have uploaded.
- **Couldn’t save on this device — download a backup**: uploads pause until local persistence recovers. Use Options to download work and retry saving.

Sync now is a manual retry, not a required step. Options holds device naming, local-save retry, and recovery downloads. A device name is remembered per browser and origin; it accompanies its future changes. Renaming alone never uploads records. Dates display in the browser timezone. Preferences such as light/dark mode stay local.

Reloading does not warn merely because a durable outbox is awaiting cloud upload. It still warns about unpersisted work or visible unfinished forms. Save Record/Save in the record form commits the form; toolbar buttons do not save draft inputs.

Saved Records opens as the main view with the list expanded. Search covers the entire collection, while cards load 30 at a time with Show more. New record opens a phone-friendly form. Schema/import/export tools are folded below the list. Existing record editing, copying, filtering, reports, and aftersales functions remain available.

## Merge and integrity rules

The database retains `app_state.payload` and existing record IDs; no bulk conversion into separate record tables occurs. PostgreSQL locks that row and applies the ordered field changes in one transaction. Whole-dataset replacements are no longer used for normal edits. Request receipts make retries safe after a lost response; a UUID is never reused for changed content. Browser direct writes and the legacy whole-payload RPC are denied.

Deleting a record removes it and stores a tombstone. Stale updates/creates cannot resurrect that ID; their attempted changes are archived for recovery. Deletions win over later stale edits. A genuinely new record has a new ID. Schema deletion/rename also retires old keys; stale edits to removed keys are archived. Renames move the latest database values and update shared filter references. Field additions and reordering preserve independent additions from other devices. Reusing retired field names may require review rather than silently reviving old edits.

Excel replacement, clearing aftersales, and JSON replacement keep their explicit user actions. They compare the content the user acted on with current cloud content, then advance dataset/group generations. A stale device from an earlier generation cannot overwrite a replacement. Such structural/destructive mismatches still require review; ordinary field edits do not. Before replacement, preserve backups. Confirmed replacement changes the entire selected group, not just the visible search results.

A device with queued changes is not blindly refreshed over its local copy. After acknowledgement, remote data appears when no record form is being edited. Lightweight polling checks only revision/source metadata until a full refresh is needed, avoiding repeated downloads of all photo-containing payloads.

## Recovery and remaining limits

`maya_change_history` records accepted change batches and previous affected record values. Schema renames/deletions and bulk replacements may retain the previous complete payload; regular edits retain affected records rather than the entire collection. History, receipts, and tombstones have no automatic pruning policy, so monitor database storage. History is private to database administrators; it is not a public browser undo API. This update does not add an undo screen.

Skipped stale edits are acknowledged with a visible recovery notice and a device backup. Download device backup exports the current state/outbox; Download preserved copies exports archived attempts or legacy snapshots. These files contain personal data and are recovery envelopes, not the app's ordinary import format. Do not blindly import them as replacement data. Browser clearing, storage eviction, or switching website origins can remove or separate pending copies; retain independent backups.

Atomicity uses one row lock, appropriate to this personal workflow. It is not a scale-out multi-user architecture. A new browser cannot open the site from scratch offline unless its assets are available; no service worker/cold-offline asset installation was added. Keep the app loaded for offline field entry. Library-dependent Excel actions still require their libraries to be loaded.

Authentication is unchanged. The public client role can access the shared data; personal use does not make it private. The migration does not add sign-in or ownership policies. Privileged administrator/service-role edits remain outside browser concurrency rules and must coordinate generations and revisions.

## Rollback

Use `supabase/manual/06-rollback-automatic-merge.sql` only for a coordinated rollback to the previous revision-protected frontend. Back up cloud and pending device copies first. It disables v2 writes, restores the v1 save RPC, invalidates old generations/base revisions, and retains records/history. It does not restore historical values. Keep v2 device outboxes for recovery. Do not use v1 emergency script `03` merely to roll back this update, since it restores unrestricted legacy table writes.

Any later return to v2 requires a planned cutover that invalidates generations after the final v1 write; do not simply regrant access or rerun `04` against the existing schema.

## Local validation (synthetic database only)

Start a disposable PostgreSQL 17 container named `maya-merge-test`, initialized with `POSTGRES_HOST_AUTH_METHOD=trust` and no published database ports. Run `tests/sync-database-bootstrap.sql`, `01-sync-migration.sql`, and `04-automatic-merge.sql` through `psql -v ON_ERROR_STOP=1`. These test commands must never target production. The original `tests/sync-database.sql` exercises v1 only, before `04`.

Run `node tests/sync-changes.cjs` and `node tests/merge-database.cjs`. Database tests cover field merges, concurrent requests, idempotence, deletions, schema operations, atomic rejection, generations, and permissions. They reset the synthetic fixture in the disposable container.

For browser tests, serve the checkout on loopback port 8000. In an environment with Playwright and `/usr/bin/chromium`, generate temporary test styles with:

```sh
npm --cache /tmp/maya-npm-cache exec --yes --package=tailwindcss@3.4.17 -- tailwindcss -i tests/tailwind.css -o /tmp/maya-test-styles.css --content ./index.html
node tests/phone-layout.cjs
node tests/sync-browser.cjs
```

Browser tests intercept every external request and use the isolated PostgreSQL functions through a local binding. They test offline reload, reconnect/timer retries, same-field ordering, device names, lost responses, edits during upload, storage errors, drafts, imports, pagination, stale generations, and phone layout. `MAYA_TEST_CSS` can point to another temporary stylesheet; database helpers accept `MAYA_TEST_CONTAINER` only for container names ending in `test`.

No live Supabase writes or production deployment are part of these tests.
