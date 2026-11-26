(function (root) {
  const clone = (x) => structuredClone(x);
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, canonical(value[k])]),
          )
        : value;
  const rowKey = (row) => JSON.stringify(canonical(row.details || {}));
  const normalizeVisit = (value) =>
    String(value || "")
      .trim()
      .toLowerCase() === "visited"
      ? "Visited"
      : "None";
  const options = (kind) =>
    kind === "visits"
      ? {
          markerHeader: "__PROJECT_MAYA_VISIT_V1__",
          normalizeStatus: normalizeVisit,
        }
      : {};
  function merge(sources) {
    const ordered = [...sources].sort((a, b) =>
      BigInt(a.uploadOrder) < BigInt(b.uploadOrder) ? -1 : 1,
    );
    const headers = [...new Set(ordered.flatMap((d) => d.headers))],
      rows = new Map();
    for (const source of ordered)
      for (const row of source.records)
        rows.set(rowKey(row), { ...clone(row), id: crypto.randomUUID() });
    return { headers, records: [...rows.values()] };
  }
  function replay(base, outbox) {
    const state = clone(base);
    for (const batch of outbox)
      for (const a of batch.p_actions) {
        const d = state.datasets.find((x) => x.id === a.id);
        if (a.kind === "map_settings") state.mapSettings = clone(a.settings);
        else if (a.kind === "create_dataset")
          state.datasets.push({
            id: a.id,
            kind: a.datasetKind,
            name: a.name,
            filename: a.filename,
            headers: clone(a.headers),
            records: clone(a.records),
            generation: "0",
            revision: "0",
            uploadOrder: null,
            uploadedAt: null,
          });
        else if (a.kind === "merge_datasets")
          state.datasets.push(clone(a.optimistic));
        else if (d && a.kind === "replace_dataset")
          Object.assign(d, {
            name: a.filename,
            filename: a.filename,
            headers: clone(a.headers),
            records: clone(a.records),
            generation: String(BigInt(d.generation) + 1n),
            uploadOrder: null,
            uploadedAt: null,
          });
        else if (d && ["set_filter", "delete_filter"].includes(a.kind)) {
          d.filters ||= {};
          if (a.kind === "set_filter") d.filters[a.filterId] = clone(a.filter);
          else delete d.filters[a.filterId];
        } else if (d && a.kind === "delete_dataset")
          state.datasets = state.datasets.filter((x) => x.id !== a.id);
        else if (d && ["set_marker", "patch_record"].includes(a.kind)) {
          const row = d.records.find((x) => String(x.id) === a.recordId);
          if (row) {
            if (a.kind === "set_marker") row.status = a.status;
            else row.details = { ...row.details, ...a.fields };
          }
        }
      }
    return state;
  }
  function createAftersalesPreferences(storage) {
    const key = "maya-aftersales-preferences-v1";
    let state = {};
    try {
      const saved = JSON.parse(storage().getItem(key));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) state = saved;
    } catch {}
    return {
      get: () => state,
      save(changes) {
        const next = { ...state, ...changes };
        storage().setItem(key, JSON.stringify(next));
        state = next;
      },
    };
  }
  const rowLinkKey = (dataset, row) =>
    JSON.stringify([dataset.id, dataset.generation, row.id]);
  function matchAftersales(dataset, saved, preferences) {
    const normalize = (value) => String(value ?? "").trim();
    const records = new Map(saved.establishments.map((r) => [String(r.id), r]));
    const pairs = (preferences.pairs ?? [{ excel: "MID", saved: "MID" }])
      .filter(({ excel, saved: field }) =>
        dataset.headers.includes(excel) &&
        (field === null || saved.customFields.some((f) => f.key === field)),
      );
    const indexes = pairs.map(({ excel, saved: field }) => {
      const index = new Map();
      for (const record of records.values()) {
        const value = normalize(field === null ? record.name : record.details?.[field]);
        if (value && value !== "—") {
          if (!index.has(value)) index.set(value, []);
          index.get(value).push(record);
        }
      }
      return { excel, index };
    });
    return (row) => {
      const linked = preferences.links?.[rowLinkKey(dataset, row)] ?? row.linkedRecordId;
      if (linked) return records.get(linked) || null;
      let match = null;
      for (const { excel, index } of indexes) {
        const value = normalize(row.details?.[excel]);
        const candidates = index.get(value);
        if (!candidates) continue;
        if (candidates.length !== 1 || (match && match !== candidates[0])) return null;
        match = candidates[0];
      }
      return match;
    };
  }
  const api = { canonical, rowKey, merge, normalizeVisit, options, replay,
    createAftersalesPreferences, matchAftersales, rowLinkKey };
  root.MayaWorkspaceTools = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
