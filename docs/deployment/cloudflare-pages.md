# Cloudflare Pages migration

Status: deployed to https://procast-maya-data.pages.dev/ from `deploy/cloudflare-pages` (initial deployment commit `bd6443c`). On November 4, 2026 (Asia/Manila), the owner confirmed the live app works and provided a screenshot showing records loaded and “All changes saved to cloud.” This is owner-verified live validation; the agent's direct HTTP checks remain blocked by the execution environment's network policy. Local automated build/routing/browser checks passed. Vercel remains unchanged. No database changes were executed for this migration.

Remaining operational checks: repair/verify the GitHub connection warning shown in Cloudflare so future pushes deploy reliably; finish moving each device only after its Vercel-origin pending work has synced or been preserved. No Vercel retirement, DNS change, redirect, or PR merge has been performed.

## What was checked

| Area | Finding |
| --- | --- |
| Build | Static `index.html`, `sync.js`, `sync-changes.js`, and `aftersales-workbook.js`; no framework, package manifest, bundler, SSR, or Vercel Functions. A dependency-free Node build now copies only public assets into `dist`. |
| Routing | One app at `/`. Local script paths stay relative. No client-side history router or deep-link routes were found. A top-level `404.html` prevents Pages' default SPA fallback from returning the app for missing scripts or private repo paths. |
| Environment | The browser currently uses an embedded public Supabase URL/anon key. There are no application `process.env`/`import.meta.env` bindings or Vercel-only runtime variables to transfer. Do not add a service-role secret to this static site. |
| Authentication | No implemented sign-in/sign-out, OAuth redirectTo, callback route, auth middleware, or passkey enrollment. The device-access design in `docs/proposals` remains a proposal. There is no current callback to migrate. Supabase dashboard auth settings were not accessed or changed. |
| Database | Same Supabase project and existing RPCs. No SQL, RLS, grants, history, schema, or records need to change for hosting. |
| Browser storage | IndexedDB, localStorage, pending outboxes, and device labels are origin-specific. A new pages.dev address cannot automatically read Vercel's local pending work or remembered device name. |
| Vercel | No Vercel project, domain, redirect, setting, or app source was modified. Network access from this task to the public Vercel URL is currently blocked, so external Vercel health is not independently verified. |

The build deliberately excludes SQL, tests, proposals, Git metadata, deployment credentials, and source-side configuration from the public site. `cloudflare/_headers` revalidates the non-fingerprinted app files so HTML and synchronization scripts are not stuck at different versions. CDN-hosted Tailwind, Supabase JS, SheetJS, and fonts remain external dependencies; this migration does not add offline cold startup.

## Create the separate GitHub-linked Pages project

Keep the existing iron-vault Cloudflare project and Vercel procast project running.

From the Cloudflare Workers & Pages screen, choose Create application, then the Pages flow (rather than a Worker), and connect/import the GitHub repository `matthue-ops/procast-maya-data`. If it is missing, add this repository to the existing Cloudflare GitHub App installation's access; do not remove iron-vault access.

Use these settings:

| Setting | Value |
| --- | --- |
| Project name | `procast-maya-data` (or a distinct available name; align `wrangler.jsonc` if changed) |
| Initial branch | `deploy/cloudflare-pages` |
| Framework preset | None |
| Root directory | Repository root; leave blank if the UI uses blank for root |
| Build command | `node scripts/build-pages.mjs` |
| Build output directory | `dist` |
| Application environment variables | None required |
| Node version | Default supported Node 20+ is sufficient; Node 22 is a suitable build setting if a pin is wanted |

The initial branch is important: when inspected, GitHub `main` still pointed to an older app than the working Vercel deployment. The migration branch includes the current synchronization code. Do not deploy old main and assume it contains the fixes. After reviewing/merging the PR, the project can use main for normal production builds.

A Pages deployment marked Production is still a separate Cloudflare address; creating it does not move or shut down the Vercel site. Copy the actual URL Cloudflare reports rather than assuming a globally available pages.dev hostname.

Prefer creating this project through Git integration for automatic deployments after pushes/merges. Do not create a separate direct-upload project as a shortcut if future Git integration is the intended workflow. The repo configuration is usable with either deployment method; no Cloudflare account secret is needed inside the application or GitHub-linked Pages build settings.

## Direct CLI access, if used

Wrangler 4.157.0 was used for local validation. Direct deployment needs an authenticated CLI or a securely provided `CLOUDFLARE_API_TOKEN` scoped to Pages editing in the intended account, plus `CLOUDFLARE_ACCOUNT_ID`. The dashboard account link identifies the account but does not grant API access. Tokens must never be committed, placed in the static artifact, or pasted into chat.

This environment has a saved draft requirement for the token, account ID, and the necessary outbound domains. A draft save does not apply network access or install a token. Runtime access must be rechecked after configuration is securely saved/applied. Current API connectivity is blocked by the active policy, and Wrangler reports no authentication.

After the owner creates/identifies the intended Pages project and access is working, list/check that project before deploying. Use an explicit project name and preview branch; do not overwrite an unrelated project or use a temporary anonymous deployment account. Do not change DNS or Vercel at this stage.

```sh
node scripts/build-pages.mjs
npx --yes wrangler@4.157.0 pages deploy dist --project-name procast-maya-data --branch cloudflare-migration
```

This CLI command is a deployment step to run only after the target/account are confirmed; it has not been executed in this task.

## Validation before cutover

1. Confirm a successful Pages build and copy its actual HTTPS URL.
2. Verify `/` and both scripts load; missing paths return 404. Confirm the app's search, Saved Records, aftersales tab, and phone layout work.
3. Use a fresh browser context and block writes to live Supabase during automated hosting tests. Existing local outboxes can upload during app startup or focus. Hosting tests use synthetic Supabase responses, never production mutation calls.
4. Verify external library/font loading and read-only Supabase connectivity from the actual Pages origin. Current local browser tests mock those external dependencies, so they do not establish live integration readiness.
5. Do not create live test records or execute database changes without explaining them and obtaining the owner's approval. Offline/reconnect behavior has a synthetic hosting test.
6. Treat deployment URLs/aliases with different origins as separate browser installations. Do not collect offline field data on a temporary preview URL and then assume it will move into the final production address.

Future authentication requires a separate reviewed change: the final HTTPS origin, exact allowed callbacks, session storage, passkey relying-party scope, and device re-enrollment would need consideration. No wildcard callback or fake `/auth/callback` was added here.

## Moving devices safely, and rollback

For every phone/PC/browser using Vercel:

1. Back up current local data. Open the old address while online and wait for All changes saved to cloud. Resolve any previous-version/structural review first. Do not clear old site storage.
2. Open the final tested Pages URL and confirm the expected records appear from the same Supabase project.
3. Set its device name again under Options. Update bookmarks only after read-only validation succeeds. Keep Vercel available until every device's pending queue is accounted for.
4. Never import an old whole-dataset backup merely to transfer site storage: it could overwrite newer records. If an offline device cannot sync, preserve its recovery envelope and assess it separately.

If Cloudflare fails, stop editing there, preserve/sync any Pages-origin pending work, and return to the still-running Vercel URL. Cloud data is shared, but offline queues are not. No database rollback is required for this hosting migration. Do not run the existing synchronization rollback SQL scripts, as they change the sync protocol and are unrelated to hosting.

Vercel retirement, custom-domain/DNS changes, and redirects are deferred until the real Cloudflare deployment is tested and all device outboxes are safe.

## Reproducible local checks

```sh
node scripts/build-pages.mjs
node tests/pages-build.mjs
WRANGLER_SEND_METRICS=false npx --yes wrangler@4.157.0 pages dev dist --ip 127.0.0.1 --port 8788 --show-interactive-dev-session=false
```

In a second terminal with Playwright and `/usr/bin/chromium` available:

```sh
npm exec --yes --package=tailwindcss@3.4.17 -- tailwindcss -i tests/tailwind.css -o /tmp/maya-pages-test.css --content ./index.html
node tests/pages-smoke.cjs
```

`PAGES_TEST_URL` can target the deployed Pages URL for the same hosting checks; `MAYA_TEST_CSS` selects a temporary generated stylesheet. External browser APIs are mocked. The HTTP checks still contact the target host to validate real routing/assets/headers.

Wrangler's local emulator applies the `_headers` rule correctly, but a direct request to the reserved `/_headers` path currently produces an emulator ENOTDIR/502 rather than a normal public route. The migration does not expose or link that internal path; ordinary missing app paths are tested as 404. Live edge behavior remains to be checked after deployment.

## Later maps and dataset feature

The feature branch expands the public build to 20 allowlisted files, including workspace modules, map modules, CSS and Leaflet assets. Its SQL upgrade is separate from the original hosting migration. See [maps-and-datasets.md](maps-and-datasets.md) for the required coordinated database approval and cutover.
