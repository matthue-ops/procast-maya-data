const assert = require("node:assert/strict");
const M = require("../map-model.js"),
  T = require("../workspace-tools.js");
const now = new Date("2026-11-06T02:00:00Z"),
  s = { greenDays: 30, orangeDays: 60 };
assert.deepEqual(
  M.coordinates("9.6447561998793, 123.85308298023159"),
  [9.6447561998793, 123.85308298023159],
);
for (const v of [
  "123,9",
  "bad",
  "https://maps.google.com/?q=9,123",
  "9,123,5",
  "NaN,123",
])
  assert.equal(M.coordinates(v), null);
assert.equal(M.today(new Date("2026-11-05T16:01:00Z")), "2026-11-06");
for (const [date, category] of [
  ["2026-11-06", "recent"],
  ["2026-10-07", "recent"],
  ["2026-10-06", "due"],
  ["2026-09-07", "due"],
  ["2026-09-06", "overdue"],
  ["2026-11-07", "future"],
  ["2026-02-30", "invalid"],
  ["", "unvisited"],
])
  assert.equal(M.visit(date, s, now).category, category, date);
assert.equal(M.visit("2026-09-24", s, now).age, 43);
assert.equal(
  M.visit("2026-10-17", { greenDays: 10, orangeDays: 15 }, now).category,
  "overdue",
);
console.log(
  "PASS coordinate validation, Philippine day boundaries, date validity and editable cutoff boundaries",
);
const sources = [
  {
    uploadOrder: "9",
    headers: ["Name", "X"],
    records: [
      { id: "1", details: { Name: "A", X: "1" }, status: "Resolved" },
      { id: "2", details: { Name: "B", X: "1" }, status: "None" },
    ],
  },
  {
    uploadOrder: "10",
    headers: ["X", "Name"],
    records: [
      { id: "3", details: { X: "1", Name: "A" }, status: "Unresolved" },
      { id: "4", details: { Name: "A", X: "2" }, status: "None" },
      { id: "5", details: { Name: "a", X: "1" }, status: "None" },
      { id: "6", details: { Name: "A ", X: "1" }, status: "None" },
    ],
  },
];
const before = structuredClone(sources),
  merged = T.merge(sources);
assert.equal(merged.records.length, 5);
assert.equal(
  merged.records.find((r) => r.details.Name === "A" && r.details.X === "1")
    .status,
  "Unresolved",
);
assert.deepEqual(sources, before);
assert.notEqual(T.rowKey({ details: { A: "" } }), T.rowKey({ details: {} }));
console.log(
  "PASS exact field/value dedupe, column-order independence, case/whitespace differences and newer upload priority",
);
const base = { datasets: [], mapSettings: s };
const create = {
  kind: "create_dataset",
  id: "one",
  datasetKind: "visits",
  name: "One.xlsx",
  filename: "One.xlsx",
  headers: ["Name"],
  records: [{ id: "r", details: { Name: "A" }, status: "None" }],
};
const replay = T.replay(base, [
  { p_actions: [create] },
  {
    p_actions: [
      { kind: "set_marker", id: "one", recordId: "r", status: "Visited" },
    ],
  },
]);
assert.equal(replay.datasets[0].records[0].status, "Visited");
assert.equal(base.datasets.length, 0);
console.log(
  "PASS optimistic replay keeps datasets independent without mutating the server baseline",
);
const XLSX = require(
    process.env.MAYA_XLSX_MODULE ||
      "/tmp/maya-excel-tests/node_modules/xlsx-js-style",
  ),
  A = require("../aftersales-workbook.js");
const b = A.makeWorkbook(
  XLSX,
  ["A", "B"],
  [{ details: { A: "Name" }, status: "Visited" }],
  { ...T.options("visits"), preserveFields: true },
);
const serialized = XLSX.write(b, { type: "buffer", bookType: "xlsx" }),
  roundtrip = XLSX.read(serialized, { type: "buffer", cellStyles: true }),
  sheet = roundtrip.Sheets[roundtrip.SheetNames[0]];
const p = A.parseSheet(XLSX, sheet, {
  ...T.options("visits"),
  preserveFields: true,
  blankValue: "",
});
assert.equal(p.rows[0].status, "Visited");
assert.deepEqual(p.rows[0].details, { A: "Name" });
assert.equal(sheet["!cols"][2].hidden, true);
assert.equal(sheet["!cols"][3].hidden, true);
console.log(
  "PASS hidden visit markers and business-key presence survive the new workbook format",
);
