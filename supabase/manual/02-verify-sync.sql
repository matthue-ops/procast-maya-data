-- Run after migration. No writes and no record payloads returned.
SELECT id, sync_revision::text, updated_at, jsonb_typeof(payload) AS payload_type
FROM public.app_state WHERE id = 'main_data';

SELECT r AS role_name,
  has_table_privilege(r, 'public.app_state', 'SELECT') AS can_read,
  has_table_privilege(r, 'public.app_state', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS direct_write,
  has_any_column_privilege(r, 'public.app_state', 'INSERT,UPDATE') AS column_write,
  has_function_privilege(r, 'public.maya_save_state(bigint,uuid,jsonb)', 'EXECUTE') AS can_sync
FROM unnest(ARRAY['anon', 'authenticated']) AS r;
-- Expected: can_read=true, direct_write=false, column_write=false, can_sync=true.

SELECT p.proname, p.prosecdef AS security_definer, p.proconfig,
       pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('maya_save_state', 'maya_read_state');
