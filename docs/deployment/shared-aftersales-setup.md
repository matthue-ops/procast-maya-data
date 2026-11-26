# Shared Aftersales setup

Aftersales matching rules, reusable filter definitions, and manual row links sync through the workspace outbox. File selection, active filter selection, and the default Saved Records map are device-specific. Manual links are scoped to the file generation and row ID. Replacing an upload creates a new generation. Saved Records and their coordinates are read when rendering pins.

## Rollout

1. Let pending workspace batches sync, download workspace recovery files, and take a Supabase backup. Close the app on other devices while applying the migration.
2. In the intended Supabase project, apply `supabase/manual/11-shared-aftersales-setup.sql` after migration 10. It runs in a transaction and adds one metadata table. The production deploy branch still builds with `node scripts/build-pages.mjs` and publishes `dist`.
3. Deploy the new Pages revision, apply its update on the device with the existing Aftersales setup, and open **Aftersales → File management & recovery → Import this browser’s Aftersales setup**. Import adds missing settings, reports conflicts and unavailable rows, and preserves the cloud values for conflicts. Local setup remains in this browser for reference. Repeat on other browsers if they have additional setup.
4. After workspace sync finishes, open the same Aftersales file on a second device and verify its matching rules, linked rows, field filters, and pins.

The migration preserves the existing workspace RPC grants and extends their snapshot. Existing file actions are delegated to the previous implementation. New setup writes use the same receipt, revision, history, and conflict-review mechanism. An outdated edit that conflicts with another device stays in the workspace’s held batch. Download a workspace recovery file before discarding the blocked batch, then reapply the intended change against the current settings.

## Rollback

If the new frontend needs reverting, first let queued workspace setup changes sync or preserve their recovery files. Revert the frontend while keeping migration 11 installed. The previous frontend can still use the existing file RPCs and browser-local setup. Keep the shared table so a later frontend redeploy can recover the shared settings. Dropping the table would remove links, matching rules, and presets and would require a separately reviewed database rollback.
