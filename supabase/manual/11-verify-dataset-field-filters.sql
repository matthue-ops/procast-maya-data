-- Read-only: confirm counts and protected metadata after 10.
SELECT id,kind,name,deleted,jsonb_array_length(records) AS records,field_filters FROM public.maya_datasets ORDER BY upload_order;
SELECT public.maya_workspace_status();
SELECT has_table_privilege('anon','public.maya_datasets','UPDATE') AS direct_write_allowed,
 has_function_privilege('anon','public.maya_workspace_apply(uuid,jsonb,text)','EXECUTE') AS rpc_enabled;
