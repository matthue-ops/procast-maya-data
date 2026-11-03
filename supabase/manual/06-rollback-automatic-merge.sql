-- Roll back ONLY v2 merging to the previous revision-protected frontend.
-- Back up cloud and every pending device copy, close all tabs, coordinate app rollback.
-- Does not restore historical payloads or allow direct browser writes.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.app_state IN ACCESS EXCLUSIVE MODE;
REVOKE EXECUTE ON FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.maya_sync_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.maya_save_state(bigint,uuid,jsonb) TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.maya_read_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
 SELECT jsonb_build_object('payload',payload,'revision',sync_revision::text,'updated_at',updated_at)
 FROM public.app_state WHERE id='main_data';
$$;
-- Retire old generations and base revisions without altering the records.
UPDATE public.app_state SET sync_revision=sync_revision+1,
 sync_epoch=sync_epoch+1,aftersales_epoch=aftersales_epoch+1 WHERE id='main_data';
NOTIFY pgrst,'reload schema';
COMMIT;
-- Redeploy the prior v1 frontend. Keep v2 local outboxes/history for recovery.
-- Any later v2 cutover must retire generations again AFTER the final v1 write.
-- Do not rerun 04 against an already-upgraded schema or simply regrant RPC access.
