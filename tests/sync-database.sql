SET ROLE anon;
DO $$
DECLARE r jsonb;
BEGIN
 r := public.maya_read_state();
 IF r->>'revision' <> '0' THEN RAISE EXCEPTION 'initial revision wrong'; END IF;
 r := public.maya_save_state(0,'00000000-0000-4000-8000-000000000001','{"test":"first"}');
 IF r->>'status' <> 'saved' OR r->>'saved_revision' <> '1' THEN RAISE EXCEPTION 'save failed'; END IF;
 r := public.maya_save_state(0,'00000000-0000-4000-8000-000000000001','{"test":"first"}');
 IF r->>'status' <> 'already_saved' THEN RAISE EXCEPTION 'retry failed'; END IF;
 r := public.maya_save_state(0,'00000000-0000-4000-8000-000000000002','{"test":"stale"}');
 IF r->>'status' <> 'conflict' THEN RAISE EXCEPTION 'stale write accepted'; END IF;
 IF (public.maya_read_state()->'payload'->>'test') <> 'first' THEN RAISE EXCEPTION 'conflict changed data'; END IF;
 BEGIN
  PERFORM public.maya_save_state(0,'00000000-0000-4000-8000-000000000001','{"test":"different"}');
  RAISE EXCEPTION 'reused request ID accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  UPDATE public.app_state SET payload = '{}' WHERE id = 'main_data';
  RAISE EXCEPTION 'direct update accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  INSERT INTO public.app_state(id,payload) VALUES('main_data','{}') ON CONFLICT(id) DO UPDATE SET payload = excluded.payload;
  RAISE EXCEPTION 'legacy upsert accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  TRUNCATE public.app_state;
  RAISE EXCEPTION 'truncate accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM * FROM public.maya_sync_receipts;
  RAISE EXCEPTION 'receipt table exposed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET ROLE;
SELECT 'PASS save, retry, conflict, request reuse, direct update, legacy upsert, truncate, receipts' AS result;
