-- Read-only inspection after 07. Run in the SQL editor; expect protocol 3,
-- all four tables protected, no direct anon access, and the legacy copy retained.
SELECT public.maya_workspace_status() AS workspace_status;
SELECT id,kind,name,filename,upload_order,generation,revision,deleted,
 jsonb_array_length(headers) AS fields,jsonb_array_length(records) AS records
 FROM public.maya_datasets ORDER BY upload_order;
SELECT map_settings FROM public.maya_workspace_control;
SELECT jsonb_array_length(coalesce(payload->'aftersalesRecords','[]')) AS preserved_legacy_aftersales,
 jsonb_array_length(coalesce(payload->'establishments','[]')) AS saved_records
 FROM public.app_state WHERE id='main_data';
SELECT c.relname,c.relrowsecurity,
 has_table_privilege('anon',c.oid,'SELECT') AS anon_direct_read,
 has_table_privilege('anon',c.oid,'UPDATE') AS anon_direct_update
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN
 ('maya_datasets','maya_workspace_control','maya_workspace_receipts','maya_workspace_history');
SELECT has_function_privilege('anon','public.maya_workspace_apply(uuid,jsonb,text)','EXECUTE') AS workspace_rpc_enabled,
 has_function_privilege('anon','public.maya_apply_changes_saved_records_v2(uuid,bigint,bigint,jsonb,text)','EXECUTE') AS bypass_disabled;
