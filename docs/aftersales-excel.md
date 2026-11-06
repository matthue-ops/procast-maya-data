# Aftersales status views and Excel round trips

This update is limited to aftersales display/import/export and the public build asset list. It requires no SQL, schema, RLS, authentication, or RPC changes. Do not run synchronization migration/rollback scripts for this feature.

## View and export

The button beside upload/export cycles Default → Resolved → Unresolved → Default. Default shows only unmarked records. The selected status AND search must both match. The mode is view-only, defaults to unmarked on reload, and never marks a record or creates a cloud write. The count shows matching rows versus the full loaded dataset. Search remains visible when restored from local preferences.

The Export button opens a small menu:

- Export all includes every loaded aftersales record, regardless of search/status.
- Export current view includes only the current search/status matches and is disabled when none match.

Both export all original visible headers and preserve row highlighting. They use the uploaded filename, with `.xls` normalized to `.xlsx`. The browser may append a duplicate-download suffix. Existing datasets without a remembered filename, or JSON-merged datasets with multiple different source filenames, use the legacy default filename.

## Hidden marker metadata

Exports append the hidden `__PROJECT_MAYA_MARKER_V1__` column containing each row's canonical marker. It is hidden using Excel column metadata, not white text. It is not encrypted or access-controlled: spreadsheet software can reveal or remove it.

The importer reads hidden columns but strips this reserved metadata out of visible headers/details. It does not appear in app searches, copied field data, or visible report columns. Valid markers are restored; missing/invalid markers are unmarked. Older colored exports without this metadata remain unmarked when imported; colors alone are not treated as authoritative markers. A business column named `Status` remains ordinary data and does not automatically become the app's marker.

Visible-column indices are preserved when blank headers occur. Duplicate visible headers or duplicate reserved metadata headers are rejected before modifying app state, to avoid silent field overwrites. Empty data rows are ignored. Zero/false values are not replaced with dashes during export.

## Dataset replacement and integrity

Every Excel upload is parsed before changing state, then asks for confirmation: replacing the current N records with the file's M records. Cancel leaves records, markers, filename, and cloud state unchanged. This confirmation is especially important for current-view exports, which contain only a subset. It does not infer that a subset is a full dataset.

Confirmed uploads retain the existing protected `replace_aftersales` operation and group-generation checks. They continue generating new record IDs, as prior Excel replacement imports did. Stale-generation protection and database recovery history remain in place. Exporting and changing the view do not change records.

The uploaded source filename is stored as `_sourceFileName` on each aftersales record, outside its visible `details`. The existing JSON-record sync/backup path already preserves this optional property, so another device can reuse the filename without introducing a new root-level setting or SQL migration. Clearing/replacing the dataset clears/replaces these filenames with it. Older datasets simply lack the property and get the fallback name. A legacy frontend uploading Excel may omit it, so refresh devices after deployment. Older importers also do not understand the hidden marker column and may treat it as business data while resetting markers; use the updated app on every device for this Excel workflow.

Cloudflare's allowlisted build now includes `aftersales-workbook.js` with the other app files. Deploy all assets together. The feature is prepared on a review branch; merging into the configured `deploy/cloudflare-pages` branch can publish it automatically.

## Validation

The exact existing `xlsx-js-style@1.2.0` library is used to test actual workbook serialization and browser downloads, rather than mocking Excel output. Install it in a temporary test directory, leaving the app's dependencies unchanged:

```sh
npm install --prefix /tmp/maya-excel-tests --no-audit --no-fund --ignore-scripts xlsx-js-style@1.2.0
node tests/aftersales-workbook.cjs
node tests/pages-build.mjs
```

For the browser test, serve the checkout on loopback port 8000. With Playwright and Chromium installed, generate styles and run:

```sh
npm exec --yes --package=tailwindcss@3.4.17 -- tailwindcss -i tests/tailwind.css -o /tmp/maya-aftersales-test.css --content ./index.html
node tests/aftersales-browser.cjs
```

`MAYA_XLSX_MODULE`, `MAYA_TEST_CSS`, and `MAYA_TEST_URL` can select test installations/assets. Browser tests intercept external calls and use synthetic cloud data only. They cover search/status intersection, no view-triggered writes, real all/subset downloads, hidden metadata, cancellation, re-imported markers, legacy XLS files, cross-browser filenames, restored search, malformed files, marking, and phone menu layout. No live Supabase changes are performed.
