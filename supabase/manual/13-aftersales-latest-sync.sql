-- Apply after 11-shared-aftersales-setup.sql. Existing metadata and records are untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.maya_workspace_control IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.maya_workspace_snapshot() RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('protocol',3,'fieldFiltersEnabled',true,'revision',c.revision::text,'mapSettings',c.map_settings,
 'aftersalesSetupLastWriteWins',true,'aftersalesSetup', (SELECT settings FROM public.maya_aftersales_setup WHERE id),
 'datasets',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'name',d.name,'filename',d.filename,
 'uploadedAt',d.uploaded_at,'uploadOrder',d.upload_order::text,'revision',d.revision::text,
 'filters',d.field_filters,'generation',d.generation::text,'headers',d.headers,'records',d.records) ORDER BY d.upload_order)
 FROM public.maya_datasets d WHERE NOT d.deleted),'[]')) FROM public.maya_workspace_control c WHERE c.id;
$$;

CREATE OR REPLACE FUNCTION public.maya_workspace_status() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('protocol',3,'revision',revision::text,'aftersalesSetupLastWriteWins',true)
 FROM public.maya_workspace_control WHERE id;
$$;

CREATE OR REPLACE FUNCTION public.maya_workspace_apply(p_request_id uuid,p_actions jsonb,p_device_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 change jsonb; changes jsonb; next_value jsonb; current_value jsonb;
 previous jsonb := '[]'; setup jsonb; fingerprint text; prior_fingerprint text;
 section text; entry_key text; path text[]; row_key jsonb; mode text;
BEGIN
 IF jsonb_typeof(p_actions) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Invalid workspace actions' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_actions) AS a WHERE a->>'kind'='aftersales_setup') THEN
  RETURN public.maya_workspace_apply_files(p_request_id,p_actions,p_device_name);
 END IF;
 IF jsonb_array_length(p_actions)<>1 OR p_request_id IS NULL
  OR coalesce(length(btrim(p_device_name)),0) NOT BETWEEN 1 AND 40 THEN
  RAISE EXCEPTION 'Invalid Aftersales setup request' USING ERRCODE='22023';
 END IF;
 mode := coalesce(p_actions->0->>'mode','legacy');
 IF mode NOT IN ('edit','import','legacy') THEN
  RAISE EXCEPTION 'Invalid Aftersales setup mode' USING ERRCODE='22023';
 END IF;
 changes := p_actions->0->'changes';
 IF jsonb_typeof(changes) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Invalid Aftersales setup changes' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(changes) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Invalid Aftersales setup change count' USING ERRCODE='22023';
 END IF;

 PERFORM 1 FROM public.maya_workspace_control WHERE id FOR UPDATE;
 fingerprint := md5(jsonb_build_object('actions',p_actions,'device',p_device_name)::text);
 SELECT r.fingerprint INTO prior_fingerprint FROM public.maya_workspace_receipts r WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Request ID reused' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('status','already_saved','request_id',p_request_id,'state',public.maya_workspace_snapshot());
 END IF;
 SELECT s.settings INTO STRICT setup FROM public.maya_aftersales_setup s WHERE id;
 FOR change IN SELECT value FROM jsonb_array_elements(changes) LOOP
  section := change->>'section';
  entry_key := change->>'key';
  next_value := change->'value';
  IF next_value IS NULL OR NOT (change ? 'expected') THEN
   RAISE EXCEPTION 'Missing Aftersales setup value' USING ERRCODE='22023';
  END IF;
  -- Old requests used "missing" for both imports and new items. Protect shared values
  -- when replaying those requests. New edits and imports carry distinct modes.
  CASE section
   WHEN 'pairs' THEN
    path := ARRAY['pairs'];
    IF entry_key IS NOT NULL OR jsonb_typeof(next_value) IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Invalid Aftersales matching rules' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(next_value)>100 OR EXISTS (
     SELECT 1 FROM jsonb_array_elements(next_value) p
     WHERE jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'excel') IS DISTINCT FROM 'string'
      OR length(btrim(p->>'excel')) NOT BETWEEN 1 AND 512
      OR coalesce(jsonb_typeof(p->'saved'),'missing') NOT IN ('string','null')
      OR (jsonb_typeof(p->'saved')='string' AND length(btrim(p->>'saved')) NOT BETWEEN 1 AND 512)
    ) THEN RAISE EXCEPTION 'Invalid Aftersales matching rule' USING ERRCODE='22023'; END IF;
   WHEN 'filters' THEN
    path := ARRAY['filters',entry_key];
    IF entry_key IS NULL OR entry_key !~ '^[a-zA-Z0-9-]{1,80}$' THEN
     RAISE EXCEPTION 'Invalid Aftersales filter ID' USING ERRCODE='22023';
    END IF;
    IF next_value <> 'null'::jsonb THEN
     IF jsonb_typeof(next_value) IS DISTINCT FROM 'object' OR jsonb_typeof(next_value->'name') IS DISTINCT FROM 'string'
      OR length(btrim(next_value->>'name')) NOT BETWEEN 1 AND 80 OR jsonb_typeof(next_value->'fields') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid Aftersales filter' USING ERRCODE='22023';
     END IF;
     IF jsonb_array_length(next_value->'fields') NOT BETWEEN 1 AND 1000 OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(next_value->'fields') f
       WHERE jsonb_typeof(f) <> 'string' OR length(btrim(f#>>'{}')) NOT BETWEEN 1 AND 512
     ) THEN RAISE EXCEPTION 'Invalid Aftersales filter fields' USING ERRCODE='22023'; END IF;
    END IF;
   WHEN 'links' THEN
    path := ARRAY['links',entry_key];
    IF entry_key IS NULL OR length(entry_key)>2048 OR jsonb_typeof(next_value) IS DISTINCT FROM 'string'
     OR length(btrim(next_value#>>'{}')) NOT BETWEEN 1 AND 512 THEN
     RAISE EXCEPTION 'Invalid Aftersales row link' USING ERRCODE='22023';
    END IF;
    row_key := entry_key::jsonb;
    IF jsonb_typeof(row_key) IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Invalid Aftersales row key' USING ERRCODE='22023';
    END IF;
    IF jsonb_array_length(row_key)<>3 OR NOT EXISTS (
     SELECT 1 FROM public.maya_datasets d
     WHERE d.id::text=row_key->>0 AND d.generation::text=row_key->>1 AND d.kind='aftersales' AND NOT d.deleted
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.records) r WHERE r->>'id'=row_key->>2)
    ) THEN RAISE EXCEPTION 'This Aftersales row changed. Review the pending link.' USING ERRCODE='P0004'; END IF;
   ELSE
    RAISE EXCEPTION 'Invalid Aftersales setup section' USING ERRCODE='22023';
  END CASE;
  current_value := setup #> path;
  IF current_value IS NOT NULL AND (mode='import' OR (mode='legacy' AND change->>'missing'='true')) THEN
   CONTINUE;
  END IF;
  previous := previous || jsonb_build_array(jsonb_build_object('section',section,'key',entry_key,'value',current_value));
  setup := jsonb_set(setup,path,next_value);
 END LOOP;
 UPDATE public.maya_aftersales_setup SET settings=setup WHERE id;
 UPDATE public.maya_workspace_control SET revision=revision+1 WHERE id;
 INSERT INTO public.maya_workspace_history(request_id,device_name,actions,previous_values) VALUES(p_request_id,p_device_name,p_actions,previous);
 INSERT INTO public.maya_workspace_receipts VALUES(p_request_id,fingerprint);
 RETURN jsonb_build_object('status','saved','request_id',p_request_id,'state',public.maya_workspace_snapshot());
EXCEPTION WHEN SQLSTATE 'P0004' THEN
 RETURN jsonb_build_object('status','review_required','reason',SQLERRM);
END $$;
UPDATE public.maya_workspace_control SET revision=revision+1 WHERE id;
NOTIFY pgrst,'reload schema';
COMMIT;
