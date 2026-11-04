-- EMERGENCY COMPATIBILITY ROLLBACK ONLY; explicitly approve before running.
-- Restores the inspected legacy privileges AND THE STALE-OVERWRITE RISK.
-- Back up current cloud and pending device copies; coordinate all devices first.
-- Does not revert payloads or drop revision/receipt history.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.app_state IN ACCESS EXCLUSIVE MODE;
REVOKE EXECUTE ON FUNCTION public.maya_save_state(bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.maya_read_state() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.app_state TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
-- Restore the old app in coordination with this rollback.
-- Legacy writes do not increment sync_revision. Do NOT simply enable the new RPC
-- again: a future cutover must invalidate all old base revisions and pending
-- requests, then reconcile device copies. Retained receipts are not payload backups.
