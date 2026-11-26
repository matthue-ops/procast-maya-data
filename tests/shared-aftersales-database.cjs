const assert = require("node:assert/strict");
const { rpc, batch, create, sql } = require("./workspace-db-helper.cjs");

(async () => {
  const initial = await rpc("maya_workspace_snapshot");
  assert.ok(initial.aftersalesSetup, "Apply setup migration 11 to the disposable database");
  assert.ok(initial.aftersalesSetupLastWriteWins, "Apply migration 13 to the disposable database");
  const file = create("aftersales", "Shared setup test.xlsx", [
    { id: "row", status: "None", details: { Name: "Merchant" } },
  ], ["Name"]);
  const apply = (request) => rpc("maya_workspace_apply", request);
  const setup = (mode, ...changes) => batch([{ kind: "aftersales_setup", mode, changes }]);
  assert.equal((await apply(batch([file]))).status, "saved");
  const key = JSON.stringify([file.id, "0", "row"]);
  const filterId = file.id;
  const filter = { name: "Names", fields: ["Name"] };
  const first = setup("edit",
    { section: "filters", key: filterId, expected: null, missing: true, value: filter },
    { section: "links", key, expected: null, missing: true, value: "m1" },
  );
  assert.equal((await apply(first)).status, "saved");
  assert.equal((await apply(first)).status, "already_saved");
  const phone = await rpc("maya_workspace_snapshot");
  assert.equal(phone.aftersalesSetup.links[key], "m1");
  assert.deepEqual(phone.aftersalesSetup.filters[filterId], filter);
  const update = setup("edit", { section: "links", key, expected: null, missing: true, value: "m2" });
  assert.equal((await apply(update)).status, "saved");
  assert.equal((await apply(first)).status, "already_saved");
  const imports = setup("import",
    { section: "links", key, expected: null, missing: true, value: "older-link" },
    { section: "filters", key: filterId, expected: null, missing: true, value: null },
    { section: "filters", key: "unique-" + filterId, expected: null, missing: true, value: filter },
  );
  assert.equal((await apply(imports)).status, "saved");
  const stale = setup("edit",
    { section: "filters", key: "rejected-" + filterId, expected: null, value: filter },
    { section: "links", key: JSON.stringify([file.id, "999", "row"]), expected: null, value: "m3" },
  );
  assert.equal((await apply(stale)).status, "review_required");
  const end = await rpc("maya_workspace_snapshot");
  assert.equal(end.aftersalesSetup.links[key], "m2");
  assert.deepEqual(end.aftersalesSetup.filters[filterId], filter);
  assert.deepEqual(end.aftersalesSetup.filters["unique-" + filterId], filter);
  assert.equal(end.aftersalesSetup.filters["rejected-" + filterId], undefined);
  assert.deepEqual(end.datasets.find((d) => d.id === file.id).records, file.records);
  assert.equal(await sql("SELECT has_table_privilege('anon','public.maya_aftersales_setup','UPDATE') OR has_function_privilege('anon','public.maya_workspace_apply_files(uuid,jsonb,text)','EXECUTE');"), "f");
  console.log("PASS last accepted edit wins, retries preserve the newer value, imports preserve existing values, and stale rows reject atomically");
})().catch((error) => { console.error(error); process.exitCode = 1; });
