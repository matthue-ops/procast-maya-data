-- COORDINATED MANUAL ROLLBACK ONLY; requires separate approval.
-- Export every dataset and pending device recovery envelope before proceeding.
-- Revert the frontend to its pre-07 version in the same maintenance window.
-- New files/markers are retained in their tables but will be inaccessible to old UI.
-- Legacy AF is the OLD cutover snapshot; this does NOT restore new datasets into it.
-- Do not run 06 or 03 as a shortcut; do not rerun 07 after this script.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.maya_workspace_control IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.app_state IN ACCESS EXCLUSIVE MODE;
REVOKE ALL ON FUNCTION public.maya_workspace_apply(uuid,jsonb,text),
 public.maya_workspace_snapshot(),public.maya_workspace_status() FROM PUBLIC,anon,authenticated;
DROP FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text);
ALTER FUNCTION public.maya_apply_changes_saved_records_v2(uuid,bigint,bigint,jsonb,text) RENAME TO maya_apply_changes;
REVOKE ALL ON FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.maya_apply_changes(uuid,bigint,bigint,jsonb,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
-- A return to the new frontend requires a planned re-enable, not rerunning CREATEs.
