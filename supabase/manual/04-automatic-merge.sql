-- Upgrade AFTER 01-sync-migration.sql. Back up cloud and pending device copies.
-- Run as postgres, coordinate all device tabs, deploy the v2 frontend together.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.app_state IN ACCESS EXCLUSIVE MODE;
DO $preflight$
BEGIN
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Run as postgres in Supabase SQL Editor'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_state WHERE id='main_data' AND jsonb_typeof(payload)='object') THEN
  RAISE EXCEPTION 'Expected main_data object payload; restore or investigate first';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.app_state'::regclass AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'Custom triggers changed since inspection; review before upgrading';
 END IF;
END $preflight$;
ALTER TABLE public.app_state ADD COLUMN sync_epoch bigint NOT NULL DEFAULT 0,
    ADD COLUMN aftersales_epoch bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT maya_sync_epoch_nonnegative CHECK(sync_epoch>=0 AND aftersales_epoch>=0);
CREATE TABLE public.maya_merge_receipts (
    request_id uuid PRIMARY KEY, fingerprint text NOT NULL, result jsonb NOT NULL
);
CREATE TABLE public.maya_change_history (
    request_id uuid PRIMARY KEY, revision bigint NOT NULL, device_name text NOT NULL,
    changes jsonb NOT NULL, previous_values jsonb NOT NULL, saved_at timestamptz NOT NULL
);
CREATE TABLE public.maya_deleted_items (
    epoch bigint NOT NULL, group_epoch bigint NOT NULL, collection text NOT NULL,
    item_id text NOT NULL, deleted_at timestamptz NOT NULL,
    PRIMARY KEY(epoch, group_epoch, collection, item_id)
);
ALTER TABLE public.maya_merge_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maya_change_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maya_deleted_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maya_merge_receipts, public.maya_change_history, public.maya_deleted_items FROM PUBLIC, anon, authenticated;

-- Canonical comparison is used only for confirmed bulk replacements.
CREATE FUNCTION public.maya_business_data(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
 SELECT pg_catalog.jsonb_build_object(
  'customFields', coalesce(p->'customFields','[]'),
  'establishments', coalesce((SELECT jsonb_agg(v - 'collapsed' ORDER BY v->>'id') FROM jsonb_array_elements(coalesce(p->'establishments','[]')) v),'[]'),
  'savedFilters', coalesce((SELECT jsonb_agg(v ORDER BY v->>'id') FROM jsonb_array_elements(coalesce(p->'savedFilters','[]')) v),'[]'),
  'aftersalesHeaders', coalesce(p->'aftersalesHeaders','[]'),
  'aftersalesRecords', coalesce((SELECT jsonb_agg(v ORDER BY v->>'id') FROM jsonb_array_elements(coalesce(p->'aftersalesRecords','[]')) v),'[]'));
$$;
REVOKE ALL ON FUNCTION public.maya_business_data(jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.maya_validate_data(p jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE c text; a jsonb;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid payload'; END IF;
 FOREACH c IN ARRAY ARRAY['establishments','aftersalesRecords','savedFilters','customFields','aftersalesHeaders'] LOOP
  a := coalesce(p->c,'[]');
  IF jsonb_typeof(a) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid array: %',c; END IF;
  IF c IN ('establishments','aftersalesRecords','savedFilters') THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(a) v WHERE jsonb_typeof(v)<>'object' OR coalesce(v->>'id','')='')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(a) v GROUP BY v->>'id' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Missing or duplicate IDs in %. Preserve data and repair before upgrading.',c;
   END IF;
   IF c <> 'savedFilters' AND EXISTS(SELECT 1 FROM jsonb_array_elements(a) v WHERE jsonb_typeof(coalesce(v->'details','{}'))<>'object') THEN
    RAISE EXCEPTION 'Invalid record details in %',c;
   END IF;
  ELSIF c='customFields' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(a) v WHERE jsonb_typeof(v)<>'object' OR coalesce(v->>'key','')='')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(a) v GROUP BY v->>'key' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Invalid or duplicate custom field keys';
   END IF;
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(a) v WHERE jsonb_typeof(v)<>'string') THEN
   RAISE EXCEPTION 'Invalid aftersales header';
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.maya_validate_data(jsonb) FROM PUBLIC,anon,authenticated;
SELECT public.maya_validate_data(payload) FROM public.app_state WHERE id='main_data';

CREATE FUNCTION public.maya_apply_changes(p_request_id uuid, p_epoch bigint,
    p_aftersales_epoch bigint, p_changes jsonb, p_device_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
 s public.app_state%ROWTYPE; receipt public.maya_merge_receipts%ROWTYPE;
 p jsonb; op jsonb; a jsonb; row_value jsonb; new_row jsonb; d jsonb;
 before_values jsonb := '[]'; skipped jsonb := '[]'; result jsonb;
 fingerprint text; c text; k text; new_key text; field_key text; item_id text;
 found_row boolean; idx int; item jsonb; x jsonb; ep bigint; ts timestamptz;
BEGIN
 IF p_request_id IS NULL OR p_epoch IS NULL OR p_aftersales_epoch IS NULL
    OR p_device_name IS NULL OR length(btrim(p_device_name)) NOT BETWEEN 1 AND 40
    OR jsonb_typeof(p_changes) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_changes) NOT BETWEEN 1 AND 10000 THEN
  RAISE EXCEPTION 'Invalid change request' USING ERRCODE='22023';
 END IF;
 SELECT * INTO STRICT s FROM public.app_state WHERE id='main_data' FOR UPDATE;
 fingerprint := md5(jsonb_build_object('epoch',p_epoch,'aftersales_epoch',p_aftersales_epoch,
    'changes',p_changes,'device',p_device_name)::text);
 SELECT * INTO receipt FROM public.maya_merge_receipts WHERE request_id=p_request_id;
 IF FOUND THEN
  IF receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'Request ID reused' USING ERRCODE='22023'; END IF;
  RETURN receipt.result || jsonb_build_object('status','already_saved');
 END IF;
 IF p_epoch<>s.sync_epoch THEN
  RAISE EXCEPTION 'The dataset was replaced while this device was offline. Your local copy is preserved.' USING ERRCODE='P0004';
 END IF;
 p:=s.payload;
 -- Check destructive preconditions before applying ANY part of the batch.
 FOR op IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  IF (op->>'collection'='aftersalesRecords' OR op->>'kind' IN ('replace_aftersales','merge_headers'))
     AND p_aftersales_epoch<>s.aftersales_epoch THEN
   RAISE EXCEPTION 'Aftersales was replaced on another device. Your local copy is preserved.' USING ERRCODE='P0004';
  END IF;
  IF op->>'kind'='replace_all' AND public.maya_business_data(op->'expected')<>public.maya_business_data(p) THEN
   RAISE EXCEPTION 'Cloud data changed before this replacement. Review the latest copy first.' USING ERRCODE='P0004';
  ELSIF op->>'kind'='replace_aftersales' AND
    (public.maya_business_data(op->'expected')->'aftersalesRecords'<>public.maya_business_data(p)->'aftersalesRecords'
     OR coalesce(op->'expected'->'aftersalesHeaders','[]')<>coalesce(p->'aftersalesHeaders','[]')) THEN
   RAISE EXCEPTION 'Aftersales changed before this replacement. Review it first.' USING ERRCODE='P0004';
  END IF;
 END LOOP;
 FOR op IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
  k:=op->>'kind'; c:=op->>'collection'; item_id:=op->>'id';
  IF k IN ('replace_all','replace_aftersales') THEN
   before_values:=before_values||jsonb_build_array(jsonb_build_object('kind',k,'value',p));
   IF k='replace_all' THEN
    PERFORM public.maya_validate_data(op->'value');
    p:=op->'value'; s.sync_epoch:=s.sync_epoch+1; s.aftersales_epoch:=s.aftersales_epoch+1;
   ELSE
    p:=p||jsonb_build_object('aftersalesRecords',op->'value'->'aftersalesRecords','aftersalesHeaders',op->'value'->'aftersalesHeaders');
    s.aftersales_epoch:=s.aftersales_epoch+1;
   END IF;
  ELSIF k IN ('create','update','delete') THEN
   IF c NOT IN ('establishments','aftersalesRecords','savedFilters') OR c IS NULL OR coalesce(item_id,'')='' THEN
    RAISE EXCEPTION 'Invalid record target' USING ERRCODE='22023';
   END IF;
   a:=coalesce(p->c,'[]'); row_value:=NULL; idx:=NULL;
   SELECT value, ordinality::int-1 INTO row_value,idx FROM jsonb_array_elements(a) WITH ORDINALITY WHERE value->>'id'=item_id;
   found_row:=FOUND;
   ep:=CASE WHEN c='aftersalesRecords' THEN s.aftersales_epoch ELSE 0 END;
   IF k='create' THEN
    IF found_row OR EXISTS(SELECT 1 FROM public.maya_deleted_items WHERE epoch=s.sync_epoch AND group_epoch=ep AND collection=c AND maya_deleted_items.item_id=op->>'id') THEN
     skipped:=skipped||jsonb_build_array(jsonb_build_object('id',item_id,'reason','Record already exists or was deleted')); CONTINUE;
    END IF;
    new_row:=op->'value';
    IF new_row->>'id' IS DISTINCT FROM item_id OR jsonb_typeof(new_row)<>'object' THEN RAISE EXCEPTION 'Invalid create'; END IF;
    IF c='establishments' THEN
     d:='{}';
     FOR field_key,x IN SELECT * FROM jsonb_each(coalesce(new_row->'details','{}')) LOOP
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p->'customFields','[]')) f WHERE f->>'key'=field_key) THEN
       d:=jsonb_set(d,ARRAY[field_key],x,true);
      ELSE skipped:=skipped||jsonb_build_array(jsonb_build_object('id',item_id,'field',field_key,'reason','Field no longer exists')); END IF;
     END LOOP;
     new_row:=new_row||jsonb_build_object('details',d);
    END IF;
    a:=a||jsonb_build_array(new_row);
   ELSIF k='delete' THEN
    a:=coalesce((SELECT jsonb_agg(value ORDER BY ordinality) FROM jsonb_array_elements(a) WITH ORDINALITY WHERE value->>'id'<>item_id),'[]');
    INSERT INTO public.maya_deleted_items VALUES(s.sync_epoch,ep,c,item_id,clock_timestamp()) ON CONFLICT DO NOTHING;
   ELSE
    IF NOT found_row THEN
     skipped:=skipped||jsonb_build_array(jsonb_build_object('id',item_id,'reason','Record was deleted')); CONTINUE;
    END IF;
    IF jsonb_typeof(op->'set') IS DISTINCT FROM 'object' OR jsonb_typeof(op->'details_set') IS DISTINCT FROM 'object'
       OR jsonb_typeof(op->'unset') IS DISTINCT FROM 'array' OR jsonb_typeof(op->'details_unset') IS DISTINCT FROM 'array'
       OR (op->'set') ?| ARRAY['id','details','collapsed'] THEN RAISE EXCEPTION 'Invalid update'; END IF;
    new_row:=row_value||(op->'set');
    FOR field_key IN SELECT jsonb_array_elements_text(op->'unset') LOOP
     IF field_key IN ('id','details') THEN RAISE EXCEPTION 'Cannot remove identity'; END IF;
     new_row:=new_row-field_key;
    END LOOP;
    d:=coalesce(row_value->'details','{}');
    FOR field_key,x IN SELECT * FROM jsonb_each(op->'details_set') LOOP
     IF c='establishments' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p->'customFields','[]')) f WHERE f->>'key'=field_key) THEN
      skipped:=skipped||jsonb_build_array(jsonb_build_object('id',item_id,'field',field_key,'reason','Field no longer exists'));
     ELSE d:=jsonb_set(d,ARRAY[field_key],x,true); END IF;
    END LOOP;
    FOR field_key IN SELECT jsonb_array_elements_text(op->'details_unset') LOOP d:=d-field_key; END LOOP;
    IF c<>'savedFilters' THEN new_row:=new_row||jsonb_build_object('details',d); END IF;
    a:=jsonb_set(a,ARRAY[idx::text],new_row);
   END IF;
   before_values:=before_values||jsonb_build_array(jsonb_build_object('collection',c,'id',item_id,'value',row_value));
   p:=jsonb_set(p,ARRAY[c],a,true);
  ELSIF k IN ('rename_field','delete_field') THEN
   field_key:=op->>'key'; new_key:=op->>'new_key';
   IF coalesce(field_key,'')='' THEN RAISE EXCEPTION 'Invalid field key'; END IF;
   IF k='rename_field' AND (coalesce(new_key,'')='' OR new_key=field_key OR starts_with(new_key,field_key||':')) THEN RAISE EXCEPTION 'Invalid rename'; END IF;
   IF k='rename_field' AND (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'customFields') f WHERE f->>'key'=field_key)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'customFields') f WHERE f->>'key'=new_key OR starts_with(f->>'key',new_key||':'))) THEN
    RAISE EXCEPTION 'Field definitions changed. Your local copy is preserved.' USING ERRCODE='P0004';
   END IF;
   IF k='rename_field' AND EXISTS(SELECT 1 FROM public.maya_deleted_items WHERE epoch=s.sync_epoch AND collection='customFields'
      AND (maya_deleted_items.item_id=new_key OR starts_with(new_key,maya_deleted_items.item_id||':'))) THEN
    RAISE EXCEPTION 'The destination field was previously removed. Review definitions first.' USING ERRCODE='P0004';
   END IF;
   before_values:=before_values||jsonb_build_array(jsonb_build_object('kind',k,'value',p));
   INSERT INTO public.maya_deleted_items
    SELECT s.sync_epoch,0,'customFields',f->>'key',clock_timestamp()
    FROM jsonb_array_elements(p->'customFields') f
    WHERE f->>'key'=field_key OR starts_with(f->>'key',field_key||':')
    ON CONFLICT DO NOTHING;
   a:='[]';
   FOR item IN SELECT value FROM jsonb_array_elements(p->'customFields') LOOP
    IF item->>'key'=field_key OR starts_with(item->>'key',field_key||':') THEN
     IF k='delete_field' THEN CONTINUE; END IF;
     item:=item||jsonb_build_object('key',new_key||substr(item->>'key',length(field_key)+1));
    END IF;
    a:=a||jsonb_build_array(item);
   END LOOP;
   p:=jsonb_set(p,'{customFields}',a);
   a:='[]';
   FOR item IN SELECT value FROM jsonb_array_elements(p->'establishments') LOOP
    d:='{}';
    FOR c,x IN SELECT * FROM jsonb_each(coalesce(item->'details','{}')) LOOP
     IF c=field_key OR starts_with(c,field_key||':') THEN
      IF k='delete_field' THEN CONTINUE; END IF;
      c:=new_key||substr(c,length(field_key)+1);
     END IF;
     d:=jsonb_set(d,ARRAY[c],x,true);
    END LOOP;
    a:=a||jsonb_build_array(item||jsonb_build_object('details',d));
   END LOOP;
   p:=jsonb_set(p,'{establishments}',a);
   a:='[]';
   FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p->'savedFilters','[]')) LOOP
    d:='[]';
    FOR x IN SELECT value FROM jsonb_array_elements(coalesce(item->'fields','[]')) LOOP
     c:=x#>>'{}';
     IF c=field_key OR starts_with(c,field_key||':') THEN
      IF k='delete_field' THEN CONTINUE; END IF;
      x:=to_jsonb(new_key||substr(c,length(field_key)+1));
     END IF;
     d:=d||jsonb_build_array(x);
    END LOOP;
    a:=a||jsonb_build_array(item||jsonb_build_object('fields',d));
   END LOOP;
   p:=jsonb_set(p,'{savedFilters}',a,true);
  ELSIF k IN ('add_field','set_field') THEN
   item:=op->'field'; field_key:=item->>'key';
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR coalesce(field_key,'')='' THEN RAISE EXCEPTION 'Invalid field'; END IF;
   IF k='add_field' AND EXISTS(SELECT 1 FROM public.maya_deleted_items WHERE epoch=s.sync_epoch AND collection='customFields' AND (maya_deleted_items.item_id=field_key OR starts_with(field_key,maya_deleted_items.item_id||':'))) THEN
    RAISE EXCEPTION 'This field was previously removed or renamed. Review the current definitions first.' USING ERRCODE='P0004';
   END IF;
   a:=coalesce(p->'customFields','[]');
   SELECT ordinality::int-1 INTO idx FROM jsonb_array_elements(a) WITH ORDINALITY WHERE value->>'key'=field_key;
   IF k='add_field' AND FOUND THEN
    IF a->idx<>item THEN RAISE EXCEPTION 'A different definition already uses this field name.' USING ERRCODE='P0004'; END IF;
   ELSIF k='set_field' AND FOUND THEN a:=jsonb_set(a,ARRAY[idx::text],item);
   ELSIF k='set_field' THEN
    skipped:=skipped||jsonb_build_array(jsonb_build_object('field',field_key,'reason','Field no longer exists'));
   ELSE a:=a||jsonb_build_array(item);
   END IF;
   before_values:=before_values||jsonb_build_array(jsonb_build_object('kind',k,'value',p->'customFields'));
   p:=jsonb_set(p,'{customFields}',a,true);
  ELSIF k='order_fields' THEN
   IF jsonb_typeof(op->'keys') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid field order'; END IF;
   a:='[]';
   FOR field_key IN SELECT jsonb_array_elements_text(op->'keys') LOOP
    SELECT value INTO item FROM jsonb_array_elements(p->'customFields') WHERE value->>'key'=field_key;
    IF FOUND AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a) f WHERE f->>'key'=field_key) THEN a:=a||jsonb_build_array(item); END IF;
   END LOOP;
   FOR item IN SELECT value FROM jsonb_array_elements(p->'customFields') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a) f WHERE f->>'key'=item->>'key') THEN a:=a||jsonb_build_array(item); END IF;
   END LOOP;
   before_values:=before_values||jsonb_build_array(jsonb_build_object('kind',k,'value',p->'customFields'));
   p:=jsonb_set(p,'{customFields}',a);
  ELSIF k='merge_headers' THEN
   IF jsonb_typeof(op->'value') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid headers'; END IF;
   a:=coalesce(p->'aftersalesHeaders','[]');
   FOR item IN SELECT value FROM jsonb_array_elements(op->'value') LOOP IF NOT a @> jsonb_build_array(item) THEN a:=a||jsonb_build_array(item); END IF; END LOOP;
   before_values:=before_values||jsonb_build_array(jsonb_build_object('kind',k,'value',p->'aftersalesHeaders'));
   p:=jsonb_set(p,'{aftersalesHeaders}',a,true);
  ELSE RAISE EXCEPTION 'Unknown change kind: %',k USING ERRCODE='22023';
  END IF;
 END LOOP;
 PERFORM public.maya_validate_data(p);
 ts:=clock_timestamp();
 p:=p||jsonb_build_object('_syncSource',jsonb_build_object('deviceName',btrim(p_device_name)));
 UPDATE public.app_state SET payload=p, sync_revision=sync_revision+1, updated_at=ts,
    sync_epoch=s.sync_epoch, aftersales_epoch=s.aftersales_epoch WHERE id='main_data'
    RETURNING sync_revision INTO s.sync_revision;
 result:=jsonb_build_object('status','saved','request_id',p_request_id,'revision',s.sync_revision::text,
    'epoch',s.sync_epoch::text,'aftersales_epoch',s.aftersales_epoch::text,'saved_at',ts,'device_name',btrim(p_device_name),'skipped',skipped);
 INSERT INTO public.maya_change_history VALUES(p_request_id,s.sync_revision,btrim(p_device_name),p_changes,before_values,ts);
 INSERT INTO public.maya_merge_receipts VALUES(p_request_id,fingerprint,result);
 RETURN result;
EXCEPTION WHEN SQLSTATE 'P0004' THEN
 RETURN jsonb_build_object('status','review_required','reason',SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) TO anon,authenticated;
-- Older whole-payload writers must not bypass field merging.
REVOKE EXECUTE ON FUNCTION public.maya_save_state(bigint,uuid,jsonb) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.maya_read_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
 SELECT jsonb_build_object('protocol',2,'payload',payload,'revision',sync_revision::text,
    'updated_at',updated_at,'epoch',sync_epoch::text,'aftersales_epoch',aftersales_epoch::text)
 FROM public.app_state WHERE id='main_data';
$$;
-- Poll small metadata, not the full dataset (which may contain photos).
CREATE FUNCTION public.maya_sync_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
 SELECT jsonb_build_object('protocol',2,'revision',sync_revision::text,
    'updated_at',updated_at,'epoch',sync_epoch::text,'aftersales_epoch',aftersales_epoch::text,
    'device_name',coalesce(payload->'_syncSource'->>'deviceName','Unknown device'))
 FROM public.app_state WHERE id='main_data';
$$;
REVOKE ALL ON FUNCTION public.maya_sync_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.maya_sync_status() TO anon,authenticated;
DO $permissions$
DECLARE role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF has_table_privilege(role_name,'public.app_state','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
     OR has_any_column_privilege(role_name,'public.app_state','INSERT,UPDATE')
     OR has_function_privilege(role_name,'public.maya_save_state(bigint,uuid,jsonb)','EXECUTE') THEN
   RAISE EXCEPTION 'Role % can still bypass merging; review inherited/table/column grants',role_name;
  END IF;
 END LOOP;
END $permissions$;
NOTIFY pgrst,'reload schema';
COMMIT;
