process.env.MAYA_TEST_CONTAINER ||= "maya-workspaces-test";
const old = require("./merge-db-helper.cjs");
const { randomUUID } = require("node:crypto");
const quote = (v) => "'" + String(v).replace(/'/g, "''") + "'";
async function rpc(name, args) {
  if (!name.startsWith("maya_workspace_")) return old.rpc(name, args);
  const query =
    name === "maya_workspace_apply"
      ? `SELECT public.maya_workspace_apply(${quote(args.p_request_id)}::uuid,${quote(JSON.stringify(args.p_actions))}::jsonb,${quote(args.p_device_name)});`
      : `SELECT public.${name}();`;
  return JSON.parse(await old.sql("SET ROLE anon; " + query));
}
const batch = (actions) => ({
  p_request_id: randomUUID(),
  p_device_name: "Test Phone",
  p_actions: actions,
});
const create = (kind, name, records, headers = ["Name", "X"]) => ({
  kind: "create_dataset",
  id: randomUUID(),
  datasetKind: kind,
  name,
  filename: name,
  headers,
  records,
});
module.exports = { ...old, rpc, batch, create, quote };
