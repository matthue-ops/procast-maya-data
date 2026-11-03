-- PROPOSAL ONLY. Run manually only after approving and preparing the matching app.
-- Back up app_state and pending data on EVERY device first. Close old app tabs.
-- Intended runner: Supabase SQL Editor as postgres. No application records deleted.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.app_state IN ACCESS EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Run as postgres in Supabase SQL Editor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_state
                 WHERE id = 'main_data' AND jsonb_typeof(payload) = 'object') THEN
    RAISE EXCEPTION 'Expected main_data with an object payload; stop and inspect';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
             WHERE tgrelid = 'public.app_state'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Triggers changed since inspection; review before migration';
  END IF;
END
$preflight$;

-- Deliberately not IF NOT EXISTS: a rerun or name collision fails atomically.
ALTER TABLE public.app_state
  ADD COLUMN sync_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT app_state_sync_revision_nonnegative CHECK (sync_revision >= 0);

-- Receipt history lets a device recognize a successful save after a lost response.
-- No second copy of your record payload is retained here.
CREATE TABLE public.maya_sync_receipts (
  request_id uuid PRIMARY KEY,
  base_revision bigint NOT NULL,
  saved_revision bigint NOT NULL,
  payload_fingerprint text NOT NULL,
  saved_at timestamptz NOT NULL
);
ALTER TABLE public.maya_sync_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.maya_sync_receipts FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.maya_save_state(
  p_expected_revision bigint,
  p_request_id uuid,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_current public.app_state%ROWTYPE;
  v_receipt public.maya_sync_receipts%ROWTYPE;
  v_saved_at timestamptz;
  v_revision bigint;
BEGIN
  IF p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_request_id IS NULL OR p_payload IS NULL
     OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid sync arguments' USING ERRCODE = '22023';
  END IF;

  -- All saves serialize on this row; compare and write happen in one transaction.
  SELECT * INTO v_current FROM public.app_state
  WHERE id = 'main_data' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'main_data missing; restore or investigate before saving';
  END IF;

  SELECT * INTO v_receipt FROM public.maya_sync_receipts
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_receipt.base_revision <> p_expected_revision
       OR v_receipt.payload_fingerprint <> pg_catalog.md5(p_payload::text) THEN
      RAISE EXCEPTION 'Request ID reused with different content' USING ERRCODE = '22023';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_saved', 'request_id', p_request_id,
      'saved_revision', v_receipt.saved_revision::text,
      'saved_at', v_receipt.saved_at,
      'current_revision', v_current.sync_revision::text,
      'current_updated_at', v_current.updated_at);
  END IF;

  IF v_current.sync_revision <> p_expected_revision THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'conflict', 'request_id', p_request_id,
      'current_revision', v_current.sync_revision::text,
      'current_updated_at', v_current.updated_at);
  END IF;

  v_saved_at := pg_catalog.clock_timestamp();
  UPDATE public.app_state
  SET payload = p_payload, sync_revision = sync_revision + 1, updated_at = v_saved_at
  WHERE id = 'main_data'
  RETURNING sync_revision INTO v_revision;

  INSERT INTO public.maya_sync_receipts
    (request_id, base_revision, saved_revision, payload_fingerprint, saved_at)
  VALUES (p_request_id, p_expected_revision, v_revision,
          pg_catalog.md5(p_payload::text), v_saved_at);

  RETURN pg_catalog.jsonb_build_object(
    'status', 'saved', 'request_id', p_request_id,
    'saved_revision', v_revision::text, 'saved_at', v_saved_at,
    'current_revision', v_revision::text, 'current_updated_at', v_saved_at);
END
$function$;

-- Read revision as text to avoid JavaScript bigint precision loss.
CREATE FUNCTION public.maya_read_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'payload', payload, 'revision', sync_revision::text, 'updated_at', updated_at)
  FROM public.app_state WHERE id = 'main_data';
$function$;

REVOKE ALL ON FUNCTION public.maya_save_state(bigint, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.maya_read_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.maya_save_state(bigint, uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.maya_read_state() TO anon, authenticated;

-- Critical: old upserts must not be able to bypass revision protection.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.app_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.app_state TO anon, authenticated;

-- Fail closed if inherited or column-level grants still allow browser writes.
DO $privileges$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF pg_catalog.has_table_privilege(r, 'public.app_state', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
       OR pg_catalog.has_any_column_privilege(r, 'public.app_state', 'INSERT,UPDATE') THEN
      RAISE EXCEPTION 'Role % still has direct write privileges; inspect grants', r;
    END IF;
  END LOOP;
END
$privileges$;

NOTIFY pgrst, 'reload schema';
COMMIT;
