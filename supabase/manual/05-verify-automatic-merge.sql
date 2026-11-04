-- Read-only verification after 04. Does not return your record payloads.
SELECT id, sync_revision::text, sync_epoch::text, aftersales_epoch::text, updated_at,
  jsonb_array_length(coalesce(payload->'establishments','[]')) AS establishment_count,
  jsonb_array_length(coalesce(payload->'aftersalesRecords','[]')) AS aftersales_count
FROM public.app_state WHERE id='main_data';
SELECT r AS role_name,
  has_table_privilege(r,'public.app_state','SELECT') AS can_read,
  has_table_privilege(r,'public.app_state','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS direct_write,
  has_any_column_privilege(r,'public.app_state','INSERT,UPDATE') AS column_write,
  has_function_privilege(r,'public.maya_save_state(bigint,uuid,jsonb)','EXECUTE') AS legacy_save,
  has_function_privilege(r,'public.maya_apply_changes(uuid,bigint,bigint,jsonb,text)','EXECUTE') AS can_merge,
  has_function_privilege(r,'public.maya_sync_status()','EXECUTE') AS can_poll,
  has_table_privilege(r,'public.maya_change_history','SELECT') AS can_read_history
FROM unnest(ARRAY['anon','authenticated']) r;
-- Expected: can_read/can_merge/can_poll=true; all other booleans=false.
SELECT public.maya_sync_status() AS sync_metadata;
-- Expected protocol=2. This is metadata only, without the records.
SELECT count(*) AS recovery_batches FROM public.maya_change_history;
