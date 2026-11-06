// Requires disposable local container with 01,04,07,10 applied.
const assert = require("node:assert/strict");
const { rpc, sql, batch, create } = require("./workspace-db-helper.cjs");
const { randomUUID } = require("node:crypto");
(async () => {
  const file = create("aftersales", "Filter.xlsx", [
    { id: "r", details: { Name: "A", X: "1" }, status: "Resolved" },
  ]);
  const other = create("visits", "Visit.xlsx", [
    { id: "r", details: { Name: "A", X: "1" }, status: "Visited" },
  ]);
  let response = await rpc("maya_workspace_apply", batch([file, other]));
  assert.equal(response.status, "saved");
  const before = response.state.datasets.find((d) => d.id === file.id),
    filterId = randomUUID();
  const filter = { name: "Contact", fields: ["Name"] };
  const action = {
    kind: "set_filter",
    id: file.id,
    generation: "0",
    filterId,
    expectedFilter: null,
    filter,
  };
  const request = batch([action]);
  response = await rpc("maya_workspace_apply", request);
  assert.equal(response.status, "saved");
  assert.equal(response.state.fieldFiltersEnabled, true);
  assert.deepEqual(
    response.state.datasets.find((d) => d.id === file.id).filters[filterId],
    filter,
  );
  assert.deepEqual(
    response.state.datasets.find((d) => d.id === other.id).filters,
    {},
  );
  assert.deepEqual(
    response.state.datasets.find((d) => d.id === file.id).records,
    before.records,
  );
  assert.equal(
    (await rpc("maya_workspace_apply", request)).status,
    "already_saved",
  );
  assert.equal(
    (
      await rpc(
        "maya_workspace_apply",
        batch([{ ...action, filter: { name: "Stale", fields: ["X"] } }]),
      )
    ).status,
    "review_required",
  );
  await assert.rejects(
    () =>
      rpc(
        "maya_workspace_apply",
        batch([
          {
            ...action,
            filterId: randomUUID(),
            filter: { name: "Bad", fields: ["Missing"] },
          },
        ]),
      ),
    /unique existing fields/,
  );
  const changed = { name: "Renamed", fields: ["Name", "X"] };
  await rpc(
    "maya_workspace_apply",
    batch([{ ...action, expectedFilter: filter, filter: changed }]),
  );
  response = await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "replace_dataset",
        id: file.id,
        generation: "0",
        expectedRecords: before.records,
        expectedHeaders: before.headers,
        filename: "Changed.xlsx",
        headers: ["Name"],
        records: [{ id: "new", details: { Name: "B" }, status: "None" }],
      },
    ]),
  );
  const replaced = response.state.datasets.find((d) => d.id === file.id);
  assert.deepEqual(replaced.filters[filterId], changed);
  assert.equal(replaced.generation, "1");
  assert.equal(
    (
      await rpc(
        "maya_workspace_apply",
        batch([{ ...action, expectedFilter: changed }]),
      )
    ).status,
    "review_required",
  );
  response = await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "delete_filter",
        id: file.id,
        generation: "1",
        filterId,
        expectedFilter: changed,
      },
    ]),
  );
  assert.deepEqual(
    response.state.datasets.find((d) => d.id === file.id).filters,
    {},
  );
  await assert.rejects(
    () =>
      sql("SET ROLE anon; UPDATE public.maya_datasets SET field_filters='{}';"),
    /permission denied/,
  );
  console.log(
    "PASS per-file filter isolation, idempotence, stale conflict protection, field validation, rename/delete, replacement retention, and business-row integrity",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
