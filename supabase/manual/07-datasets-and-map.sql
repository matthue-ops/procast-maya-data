-- MANUAL UPGRADE after 01 and 04. Do not run against live data without approval.
-- Back up every device, sync pending legacy aftersales edits, close old tabs first.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.app_state IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'Run as postgres'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_state WHERE id='main_data') THEN RAISE EXCEPTION 'main_data missing'; END IF;
END $$;
CREATE SEQUENCE public.maya_upload_order;
CREATE TABLE public.maya_datasets(
 id uuid PRIMARY KEY,kind text NOT NULL CHECK(kind IN ('aftersales','visits')),
 name text NOT NULL,filename text NOT NULL,uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 upload_order bigint NOT NULL DEFAULT nextval('public.maya_upload_order'),
 revision bigint NOT NULL DEFAULT 1,generation bigint NOT NULL DEFAULT 0,
 deleted boolean NOT NULL DEFAULT false,headers jsonb NOT NULL,records jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.maya_workspace_control(
 id boolean PRIMARY KEY DEFAULT true CHECK(id),revision bigint NOT NULL DEFAULT 0,
 map_settings jsonb NOT NULL DEFAULT '{"greenDays":30,"orangeDays":60,"coordinateKey":"COORDINATES","visitKey":"LAST VISIT"}');
INSERT INTO public.maya_workspace_control(id) VALUES(true);
CREATE TABLE public.maya_workspace_receipts(request_id uuid PRIMARY KEY,fingerprint text NOT NULL);
CREATE TABLE public.maya_workspace_history(
 request_id uuid PRIMARY KEY,device_name text NOT NULL,actions jsonb NOT NULL,
 previous_values jsonb NOT NULL,saved_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.maya_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maya_workspace_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maya_workspace_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maya_workspace_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.maya_datasets,public.maya_workspace_control,public.maya_workspace_receipts,public.maya_workspace_history FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.maya_upload_order FROM PUBLIC,anon,authenticated;

-- Preserve current AF data/IDs/markers in a separate initial dataset. Keep legacy payload intact.
INSERT INTO public.maya_datasets(id,kind,name,filename,headers,records)
 SELECT gen_random_uuid(),'aftersales',
 coalesce((SELECT min(r->>'_sourceFileName') FROM jsonb_array_elements(coalesce(payload->'aftersalesRecords','[]')) r),'Existing Aftersales.xlsx'),
 coalesce((SELECT min(r->>'_sourceFileName') FROM jsonb_array_elements(coalesce(payload->'aftersalesRecords','[]')) r),'AFTERSALES_RECHECKING_HIGHLIGHTED.xlsx'),
 coalesce(payload->'aftersalesHeaders','[]'),coalesce(payload->'aftersalesRecords','[]')
 FROM public.app_state WHERE id='main_data' AND jsonb_array_length(coalesce(payload->'aftersalesRecords','[]'))>0;

CREATE FUNCTION public.maya_workspace_snapshot() RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('protocol',3,'revision',c.revision::text,'mapSettings',c.map_settings,
 'datasets',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'name',d.name,'filename',d.filename,
 'uploadedAt',d.uploaded_at,'uploadOrder',d.upload_order::text,'revision',d.revision::text,
 'generation',d.generation::text,'headers',d.headers,'records',d.records) ORDER BY d.upload_order)
 FROM public.maya_datasets d WHERE NOT d.deleted),'[]')) FROM public.maya_workspace_control c WHERE c.id;
$$;
CREATE FUNCTION public.maya_workspace_status() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('protocol',3,'revision',revision::text) FROM public.maya_workspace_control WHERE id;
$$;
CREATE FUNCTION public.maya_check_dataset(h jsonb,r jsonb,k text) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF k NOT IN ('aftersales','visits') OR jsonb_typeof(h) IS DISTINCT FROM 'array' OR jsonb_typeof(r) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid dataset'; END IF;
 IF jsonb_array_length(h)=0 OR jsonb_array_length(r)>50000 THEN RAISE EXCEPTION 'Invalid dataset size'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(h) v WHERE jsonb_typeof(v)<>'string' OR v#>>'{}'='')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(h) v GROUP BY v HAVING count(*)>1) THEN RAISE EXCEPTION 'Invalid/duplicate headers'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(r) v WHERE jsonb_typeof(v)<>'object' OR coalesce(v->>'id','')='' OR jsonb_typeof(v->'details') IS DISTINCT FROM 'object'
 OR coalesce(v->>'status','None') NOT IN ('None','Resolved','Unresolved','Visited')
 OR (k='aftersales' AND v->>'status'='Visited') OR (k='visits' AND coalesce(v->>'status','None') NOT IN ('None','Visited')))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(r) v GROUP BY v->>'id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Invalid records/markers/IDs'; END IF;
END $$;
CREATE FUNCTION public.maya_workspace_apply(p_request_id uuid,p_actions jsonb,p_device_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 a jsonb;d public.maya_datasets%ROWTYPE;src public.maya_datasets%ROWTYPE;
 before_values jsonb:='[]';fingerprint text;old_fingerprint text;row_value jsonb;new_rows jsonb;
 merged jsonb;key text;headers jsonb;v jsonb;entry jsonb;priority jsonb;k text;target uuid;settings jsonb;
BEGIN
 IF p_request_id IS NULL OR p_device_name IS NULL OR length(btrim(p_device_name)) NOT BETWEEN 1 AND 40
 OR jsonb_typeof(p_actions) IS DISTINCT FROM 'array' OR jsonb_array_length(p_actions) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid workspace request' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.maya_workspace_control WHERE id FOR UPDATE;
 fingerprint:=md5(jsonb_build_object('actions',p_actions,'device',p_device_name)::text);
 SELECT r.fingerprint INTO old_fingerprint FROM public.maya_workspace_receipts r WHERE request_id=p_request_id;
 IF FOUND THEN
  IF old_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Request ID reused' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('status','already_saved','request_id',p_request_id,'state',public.maya_workspace_snapshot());
 END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
  k:=a->>'kind';target:=NULL;
  IF k='map_settings' THEN
   settings:=a->'settings';
   IF jsonb_typeof(settings) IS DISTINCT FROM 'object' OR coalesce(settings->>'greenDays','')!~'^\d+$' OR coalesce(settings->>'orangeDays','')!~'^\d+$'
    OR (settings->>'greenDays')::int<0 OR (settings->>'orangeDays')::int<=(settings->>'greenDays')::int OR (settings->>'orangeDays')::int>3650
    OR length(coalesce(settings->>'coordinateKey','')) NOT BETWEEN 1 AND 512 OR length(coalesce(settings->>'visitKey','')) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION 'Invalid map settings' USING ERRCODE='22023'; END IF;
   before_values:=before_values||jsonb_build_array(jsonb_build_object('mapSettings',(SELECT map_settings FROM public.maya_workspace_control WHERE id)));
   settings:=jsonb_build_object('greenDays',(settings->>'greenDays')::int,'orangeDays',(settings->>'orangeDays')::int,'coordinateKey',settings->>'coordinateKey','visitKey',settings->>'visitKey');
   UPDATE public.maya_workspace_control SET map_settings=settings WHERE id;
  ELSIF k='create_dataset' THEN
   target:=(a->>'id')::uuid;
   IF EXISTS(SELECT 1 FROM public.maya_datasets WHERE id=target) THEN RAISE EXCEPTION 'Dataset ID already exists' USING ERRCODE='P0004'; END IF;
   PERFORM public.maya_check_dataset(a->'headers',a->'records',a->>'datasetKind');
   IF length(coalesce(a->>'name','')) NOT BETWEEN 1 AND 255 OR length(coalesce(a->>'filename','')) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Invalid filename'; END IF;
   INSERT INTO public.maya_datasets(id,kind,name,filename,headers,records) VALUES(target,a->>'datasetKind',a->>'name',a->>'filename',a->'headers',a->'records');
  ELSIF k='merge_datasets' THEN
   IF jsonb_typeof(a->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'sources')<2 THEN RAISE EXCEPTION 'Select at least two files'; END IF;
   IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(a->'sources') x)<>jsonb_array_length(a->'sources') THEN RAISE EXCEPTION 'Duplicate source selection'; END IF;
   merged:='{}';headers:='[]';priority:='[]';
   FOR src IN SELECT ds.* FROM public.maya_datasets ds JOIN jsonb_array_elements(a->'sources') x ON ds.id=(x->>'id')::uuid ORDER BY ds.upload_order LOOP
    IF src.deleted OR src.kind<>a->>'datasetKind' THEN RAISE EXCEPTION 'Source file unavailable or different type' USING ERRCODE='P0004'; END IF;
    SELECT x INTO entry FROM jsonb_array_elements(a->'sources') x WHERE x->>'id'=src.id::text;
    IF entry->'records' IS DISTINCT FROM src.records OR entry->'headers' IS DISTINCT FROM src.headers OR entry->>'uploadOrder' IS DISTINCT FROM src.upload_order::text THEN
     RAISE EXCEPTION 'A selected file changed. Review the merge again.' USING ERRCODE='P0004'; END IF;
    priority:=priority||jsonb_build_array(to_jsonb(src.id));
    FOR v IN SELECT value FROM jsonb_array_elements(src.headers) LOOP IF NOT headers @> jsonb_build_array(v) THEN headers:=headers||jsonb_build_array(v); END IF; END LOOP;
    FOR row_value IN SELECT value FROM jsonb_array_elements(src.records) LOOP
     -- JSONB equality uses every business key/value, independent of column order.
     key:=(row_value->'details')::text;
     IF a ? 'optimistic' THEN
      SELECT hint INTO v FROM jsonb_array_elements(a->'optimistic'->'records') hint WHERE hint->'details'=row_value->'details';
      IF NOT FOUND OR coalesce(v->>'id','')='' THEN RAISE EXCEPTION 'Invalid merge row identity'; END IF;
     ELSE v:=jsonb_build_object('id',gen_random_uuid()::text); END IF;
     merged:=jsonb_set(merged,ARRAY[key],(row_value-'_sourceFileName')||jsonb_build_object('id',v->>'id'),true);
    END LOOP;
   END LOOP;
   IF jsonb_array_length(priority)<>jsonb_array_length(a->'sources') THEN RAISE EXCEPTION 'A selected file is missing' USING ERRCODE='P0004'; END IF;
   SELECT coalesce(jsonb_agg(e.value ORDER BY e.key),'[]') INTO new_rows FROM jsonb_each(merged) e;
   PERFORM public.maya_check_dataset(headers,new_rows,a->>'datasetKind');
   IF length(coalesce(a->>'name','')) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Invalid merged filename'; END IF;
   INSERT INTO public.maya_datasets(id,kind,name,filename,headers,records) VALUES((a->>'id')::uuid,a->>'datasetKind',a->>'name',a->>'name',headers,new_rows);
  ELSIF k IN ('replace_dataset','delete_dataset','set_marker','patch_record') THEN
   target:=(a->>'id')::uuid;
   SELECT * INTO d FROM public.maya_datasets WHERE id=target FOR UPDATE;
   IF NOT FOUND OR d.deleted THEN RAISE EXCEPTION 'This file was deleted; pending work is preserved' USING ERRCODE='P0004'; END IF;
   IF coalesce(a->>'generation','')<>d.generation::text THEN RAISE EXCEPTION 'This file was replaced; review pending work' USING ERRCODE='P0004'; END IF;
   IF k IN ('replace_dataset','delete_dataset') THEN
    before_values:=before_values||jsonb_build_array(to_jsonb(d));
    IF a->'expectedRecords' IS DISTINCT FROM d.records OR a->'expectedHeaders' IS DISTINCT FROM d.headers THEN
     RAISE EXCEPTION 'This file changed before replacement/deletion. Review it again.' USING ERRCODE='P0004'; END IF;
    IF k='delete_dataset' THEN UPDATE public.maya_datasets SET deleted=true,revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
    ELSE
     PERFORM public.maya_check_dataset(a->'headers',a->'records',d.kind);
     IF length(coalesce(a->>'filename','')) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'Invalid filename'; END IF;
     UPDATE public.maya_datasets SET name=a->>'filename',filename=a->>'filename',headers=a->'headers',records=a->'records',generation=generation+1,revision=revision+1,
      uploaded_at=clock_timestamp(),upload_order=nextval('public.maya_upload_order'),updated_at=clock_timestamp() WHERE id=target;
    END IF;
   ELSE
    SELECT value INTO row_value FROM jsonb_array_elements(d.records) WHERE value->>'id'=a->>'recordId';
    IF NOT FOUND THEN RAISE EXCEPTION 'This row no longer exists' USING ERRCODE='P0004'; END IF;
    before_values:=before_values||jsonb_build_array(jsonb_build_object('datasetId',d.id,'generation',d.generation,'record',row_value));
    IF k='set_marker' THEN
     IF (d.kind='aftersales' AND coalesce(a->>'status','') NOT IN ('None','Resolved','Unresolved')) OR (d.kind='visits' AND coalesce(a->>'status','') NOT IN ('None','Visited')) THEN RAISE EXCEPTION 'Invalid marker'; END IF;
     row_value:=row_value||jsonb_build_object('status',a->>'status');
    ELSE
     IF jsonb_typeof(a->'fields') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid fields'; END IF;
     FOR key,v IN SELECT * FROM jsonb_each(a->'fields') LOOP
      IF NOT d.headers @> jsonb_build_array(key) THEN RAISE EXCEPTION 'Field no longer exists' USING ERRCODE='P0004'; END IF;
     END LOOP;
     row_value:=row_value||jsonb_build_object('details',(row_value->'details')||(a->'fields'));
    END IF;
    SELECT jsonb_agg(CASE WHEN value->>'id'=a->>'recordId' THEN row_value ELSE value END ORDER BY ordinality) INTO new_rows FROM jsonb_array_elements(d.records) WITH ORDINALITY;
    PERFORM public.maya_check_dataset(d.headers,new_rows,d.kind);
    UPDATE public.maya_datasets SET records=new_rows,revision=revision+1,updated_at=clock_timestamp() WHERE id=target;
   END IF;
  ELSE RAISE EXCEPTION 'Unsupported workspace action' USING ERRCODE='22023'; END IF;
 END LOOP;
 UPDATE public.maya_workspace_control SET revision=revision+1 WHERE id;
 INSERT INTO public.maya_workspace_history(request_id,device_name,actions,previous_values) VALUES(p_request_id,p_device_name,p_actions,before_values);
 INSERT INTO public.maya_workspace_receipts VALUES(p_request_id,fingerprint);
 RETURN jsonb_build_object('status','saved','request_id',p_request_id,'state',public.maya_workspace_snapshot());
EXCEPTION WHEN SQLSTATE 'P0004' THEN RETURN jsonb_build_object('status','review_required','reason',SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.maya_check_dataset(jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.maya_workspace_snapshot(),public.maya_workspace_status(),public.maya_workspace_apply(uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.maya_workspace_snapshot(),public.maya_workspace_status(),public.maya_workspace_apply(uuid,jsonb,text) TO anon,authenticated;

-- Freeze the migrated legacy AF copy, while retaining existing Saved Records sync.
ALTER FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) RENAME TO maya_apply_changes_saved_records_v2;
REVOKE ALL ON FUNCTION public.maya_apply_changes_saved_records_v2(uuid,bigint,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.maya_apply_changes(p_request_id uuid,p_epoch bigint,p_aftersales_epoch bigint,p_changes jsonb,p_device_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) x WHERE x->>'collection'='aftersalesRecords' OR x->>'kind' IN ('replace_aftersales','merge_headers')) THEN
  RETURN jsonb_build_object('status','review_required','reason','Aftersales moved to independent files. Preserve old pending edits and refresh this device.');
 END IF;
 RETURN public.maya_apply_changes_saved_records_v2(p_request_id,p_epoch,p_aftersales_epoch,p_changes,p_device_name);
END $$;
REVOKE ALL ON FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
