const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { sql, rpc, batch, create } = require("./workspace-db-helper.cjs");
const state = () => rpc("maya_workspace_snapshot");
(async () => {
  let s = await state();
  assert.equal(s.protocol, 3);
  const a = create("aftersales", "Old.xlsx", [
    { id: "r1", details: { Name: "A", X: "1" }, status: "Resolved" },
    { id: "r2", details: { Name: "B", X: "1" }, status: "None" },
  ]);
  const b = create(
    "aftersales",
    "New.xlsx",
    [
      { id: "r1", details: { X: "1", Name: "A" }, status: "Unresolved" },
      { id: "r2", details: { Name: "A", X: "2" }, status: "None" },
      { id: "r3", details: { Name: "A ", X: "1" }, status: "None" },
    ],
    ["X", "Name"],
  );
  const request = batch([a, b]);
  let response = await rpc("maya_workspace_apply", request);
  assert.equal(response.status, "saved");
  assert.ok(response.state.datasets.find((d) => d.id === b.id));
  assert.equal(
    (await rpc("maya_workspace_apply", request)).status,
    "already_saved",
  );
  await assert.rejects(
    () => rpc("maya_workspace_apply", { ...request, p_device_name: "Changed" }),
    /Request ID reused/,
  );
  s = await state();
  let da = s.datasets.find((d) => d.id === a.id),
    db = s.datasets.find((d) => d.id === b.id);
  assert.ok(BigInt(db.uploadOrder) > BigInt(da.uploadOrder));
  console.log(
    "PASS independent file creation, fresh post-write snapshot, upload ordering and idempotent retries",
  );
  await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "set_marker",
        id: da.id,
        generation: da.generation,
        recordId: "r1",
        status: "None",
      },
    ]),
  );
  s = await state();
  da = s.datasets.find((d) => d.id === a.id);
  db = s.datasets.find((d) => d.id === b.id);
  const before = structuredClone([da, db]);
  const merge = {
    kind: "merge_datasets",
    id: randomUUID(),
    datasetKind: "aftersales",
    name: "Combined.xlsx",
    sources: [da, db].map((d) => ({
      id: d.id,
      headers: d.headers,
      records: d.records,
      uploadOrder: d.uploadOrder,
    })),
  };
  merge.optimistic = {
    records: require("../workspace-tools.js").merge([da, db]).records,
  };
  response = await rpc("maya_workspace_apply", batch([merge]));
  assert.equal(response.status, "saved");
  const combined = response.state.datasets.find((d) => d.id === merge.id);
  assert.equal(combined.records.length, 4);
  assert.equal(
    combined.records.find((r) => r.details.Name === "A" && r.details.X === "1")
      .status,
    "Unresolved",
  );
  for (const d of before)
    assert.deepEqual(
      response.state.datasets.find((x) => x.id === d.id),
      d,
    );
  assert.deepEqual(
    combined.records.map((r) => r.id).sort(),
    merge.optimistic.records.map((r) => r.id).sort(),
  );
  await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "set_marker",
        id: combined.id,
        generation: combined.generation,
        recordId: merge.optimistic.records[0].id,
        status: "Resolved",
      },
    ]),
  );
  console.log(
    "PASS exact-value dedupe, newer FILE priority (not marker edit time), and unchanged originals",
  );
  const visit = create(
    "visits",
    "Visits.xlsx",
    [{ id: "r1", details: { Name: "A" }, status: "None" }],
    ["Name"],
  );
  await rpc("maya_workspace_apply", batch([visit]));
  await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "set_marker",
        id: visit.id,
        generation: "0",
        recordId: "r1",
        status: "Visited",
      },
    ]),
  );
  s = await state();
  assert.equal(
    s.datasets.find((d) => d.id === visit.id).records[0].status,
    "Visited",
  );
  assert.equal(s.datasets.find((d) => d.id === a.id).records[0].status, "None");
  const wrong = {
    ...merge,
    id: randomUUID(),
    sources: [
      s.datasets.find((d) => d.id === a.id),
      s.datasets.find((d) => d.id === visit.id),
    ].map((d) => ({
      id: d.id,
      headers: d.headers,
      records: d.records,
      uploadOrder: d.uploadOrder,
    })),
  };
  assert.equal(
    (await rpc("maya_workspace_apply", batch([wrong]))).status,
    "review_required",
  );
  console.log(
    "PASS visit markers and file scopes are isolated; cross-kind merges rejected",
  );
  da = s.datasets.find((d) => d.id === a.id);
  await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "replace_dataset",
        id: da.id,
        generation: da.generation,
        expectedRecords: da.records,
        expectedHeaders: da.headers,
        filename: "Replacement.xlsx",
        headers: ["Name"],
        records: [{ id: "fresh", details: { Name: "Fresh" }, status: "None" }],
      },
    ]),
  );
  assert.equal(
    (
      await rpc(
        "maya_workspace_apply",
        batch([
          {
            kind: "set_marker",
            id: a.id,
            generation: "0",
            recordId: "r1",
            status: "Resolved",
          },
        ]),
      )
    ).status,
    "review_required",
  );
  s = await state();
  da = s.datasets.find((d) => d.id === a.id);
  assert.equal(da.generation, "1");
  assert.equal(s.datasets.find((d) => d.id === b.id).filename, "New.xlsx");
  await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "delete_dataset",
        id: da.id,
        generation: da.generation,
        expectedRecords: da.records,
        expectedHeaders: da.headers,
      },
    ]),
  );
  assert.equal(
    (await state()).datasets.some((d) => d.id === a.id),
    false,
  );
  assert.equal(
    (await rpc("maya_workspace_apply", batch([a]))).status,
    "review_required",
  );
  console.log(
    "PASS replacement generations, scoped deletion and stale resurrection protection",
  );
  s = await state();
  db = s.datasets.find((d) => d.id === b.id);
  const prior = structuredClone(db);
  await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "patch_record",
        id: db.id,
        generation: db.generation,
        recordId: "r1",
        fields: { X: "Changed" },
      },
    ]),
  );
  const atomic = create(
    "visits",
    "Must rollback.xlsx",
    [{ id: "x", details: { Name: "X" }, status: "None" }],
    ["Name"],
  );
  const stale = {
    ...merge,
    id: randomUUID(),
    sources: [prior, combined].map((d) => ({
      id: d.id,
      headers: d.headers,
      records: d.records,
      uploadOrder: d.uploadOrder,
    })),
  };
  assert.equal(
    (await rpc("maya_workspace_apply", batch([atomic, stale]))).status,
    "review_required",
  );
  assert.equal(
    (await state()).datasets.some((d) => d.id === atomic.id),
    false,
  );
  console.log(
    "PASS stale merges roll back the entire request, including earlier creates",
  );
  await rpc(
    "maya_workspace_apply",
    batch([
      {
        kind: "map_settings",
        settings: {
          greenDays: 14,
          orangeDays: 30,
          coordinateKey: "COORDINATES",
          visitKey: "LAST VISIT",
        },
      },
    ]),
  );
  assert.equal((await state()).mapSettings.greenDays, 14);
  await assert.rejects(
    () =>
      rpc(
        "maya_workspace_apply",
        batch([
          {
            kind: "map_settings",
            settings: {
              greenDays: 30,
              orangeDays: 14,
              coordinateKey: "C",
              visitKey: "V",
            },
          },
        ]),
      ),
    /Invalid map settings/,
  );
  await assert.rejects(
    () => sql("SET ROLE anon; SELECT * FROM public.maya_workspace_history;"),
    /permission denied/,
  );
  await assert.rejects(
    () => sql("SET ROLE anon; UPDATE public.maya_datasets SET deleted=true;"),
    /permission denied/,
  );
  const legacy = await rpc("maya_apply_changes", {
    p_request_id: randomUUID(),
    p_epoch: "0",
    p_aftersales_epoch: "0",
    p_payload: {},
    p_device_name: "Old",
    p_changes: [{ kind: "replace_aftersales", expected: {}, value: {} }],
  });
  assert.equal(legacy.status, "review_required");
  console.log(
    "PASS shared threshold validation, private history, direct-write denial and frozen legacy AF writer",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
