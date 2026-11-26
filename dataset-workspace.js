window.createDatasetWorkspace = function ({ store, hosts, getState, preferences, onPreferenceChange }) {
  const T = window.MayaWorkspaceTools,
    A = window.MayaAftersales,
    views = {
      aftersales: { selected: "", query: "", mode: "None" },
      visits: { selected: "", query: "", mode: "None" },
    };
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "class") n.className = v;
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of children.flat())
      if (c != null)
        n.append(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  };
  const title = (kind) => (kind === "visits" ? "List to Visit" : "Aftersales");
  let dialog = null,
    last = "";
  function notify(message) {
    window.alert(message);
  }
  function close() {
    dialog?.remove();
    dialog = null;
    render(true);
  }
  function modal(name, content) {
    if (dialog) close();
    dialog = el(
      "dialog",
      { class: "workspace-dialog", "aria-label": name },
      el(
        "header",
        {},
        el("h3", {}, name),
        el(
          "button",
          { type: "button", onclick: close, "aria-label": "Close" },
          "×",
        ),
      ),
      content,
    );
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    dialog.addEventListener("input", (event) => {
      if (!event.target.hasAttribute("data-local-preference"))
        dialog.dataset.dirty = "true";
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  function download(value, name) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = el("a", { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const nameOf = (row, headers) => {
    const keys = headers || Object.keys(row.details || {});
    const key = keys.find((k) =>
      /^(merchant\s*name|client|name|establishment)$/i.test(k),
    );
    return String(
      row.details?.[key || keys[0]] || row.merchantName || "Record",
    );
  };
  function add(actions) {
    try {
      store.add(actions);
    } catch (error) {
      notify(error.message);
    }
  }
  async function savePreferences(section, key, value, expected) {
    try {
      if (!(await preferences.save(section, key, value, expected))) {
        notify("Could not save the setup on this device. Keep this tab open and export a workspace recovery backup.");
        return false;
      }
    } catch (error) {
      notify(error.message);
      return false;
    }
    onPreferenceChange();
    return true;
  }
  function importSetup() {
    const plan = preferences.importPlan();
    const info = el("p", {}, `${plan.changes.length} new items · ${plan.conflicts} conflicts · ${plan.unavailable} links to unavailable rows.`);
    modal("Import browser Aftersales setup", el("div", {}, info,
      el("p", {}, "Import adds missing items. The workspace keeps its version of conflicting items. You can review and reapply those changes in Matching rules, Manage filters, or the Aftersales row."),
      el("button", { disabled: !plan.changes.length, onclick: async () => {
        try {
          if (await preferences.importLocal()) close();
          else info.textContent = "Could not save the import on this device. Keep this tab open and export a workspace recovery backup.";
        } catch (error) {
          info.textContent = error.message;
        }
      } }, "Import missing items")));
  }
  function sharedFilters() {
    const filters = Object.fromEntries(store.state().datasets
      .filter((ds) => ds.kind === "aftersales")
      .flatMap((ds) => Object.entries(ds.filters || {})));
    return Object.fromEntries(Object.entries({ ...filters, ...preferences.get().filters })
      .filter(([, filter]) => filter));
  }
  function matchRows(ds) {
    return T.matchAftersales(ds, getState(), preferences.get());
  }
  function coordinateField() {
    return MayaMapModel.bindings(getState().customFields, store.state().mapSettings).coordinate?.key ?? null;
  }
  function positionOf(record, field = coordinateField()) {
    return MayaMapModel.coordinates(record?.details?.[field]);
  }
  function matchSettings() {
    const existing = preferences.get().pairs;
    const headers = [...new Set(store.state().datasets
      .filter((ds) => ds.kind === "aftersales").flatMap((ds) => ds.headers))];
    const body = el("div");
    const rows = el("div");
    function appendPair(pair = {}) {
      const excel = el("select", { "aria-label": "Excel column" },
        el("option", { value: "" }, "Choose an Excel column"),
        [...new Set([...headers, ...(pair.excel ? [pair.excel] : [])])].map((h) =>
          el("option", { value: h, selected: pair.excel === h }, h)));
      const fields = getState().customFields.map(({ key }) => key);
      if (pair.saved != null && !fields.includes(pair.saved)) fields.push(pair.saved);
      const saved = el("select", { "aria-label": "Saved Records field" },
        el("option", { value: "" }, "Choose a Saved Records field"),
        el("option", { value: "null", selected: pair.saved === null }, "Record name"),
        fields.map((field) =>
          el("option", { value: JSON.stringify(field), selected: pair.saved === field }, field)));
      const row = el("div", { class: "workspace-actions" }, excel, saved,
        el("button", { onclick: () => row.remove() }, "Remove pair"));
      rows.append(row);
    }
    (existing ?? [{ excel: "MID", saved: "MID" }]).forEach(appendPair);
    const message = el("p", { role: "status" });
    body.append(el("p", {}, "One exact, nonblank match is enough when it identifies a single Saved Record."),
      rows, el("button", { onclick: () => appendPair() }, "Add field pair"),
      message, el("button", { class: "primary", onclick: async () => {
        const pairs = [...rows.children].map((row) => {
          const [excel, saved] = row.querySelectorAll("select");
          return { excel: excel.value, saved: saved.value ? JSON.parse(saved.value) : undefined };
        });
        if (pairs.some(({ excel, saved }) => !excel || saved === undefined)) {
          message.textContent = "Choose both fields for each pair, or remove the incomplete pair.";
          return;
        }
        if (await savePreferences("pairs", undefined, pairs, existing)) close();
      } }, "Save matching rules"));
    modal(preferences.shared() ? "Shared Aftersales matching rules" : "Aftersales matching rules (this browser)", body);
  }
  function linkDialog(ds, row) {
    const key = T.rowLinkKey(ds, row);
    const existing = preferences.get().links?.[key];
    const results = el("div");
    const search = el("input", { type: "search", "aria-label": "Search Saved Records",
      placeholder: "Search by record name or field value", oninput: draw });
    function draw() {
      const query = search.value.trim().toLowerCase();
      if (!query) {
        results.textContent = "Enter a name or field value.";
        return;
      }
      const matches = getState().establishments.filter((record) =>
        [record.name, ...Object.values(record.details || {})]
          .some((value) => String(value ?? "").toLowerCase().includes(query)));
      const identifyingFields = new Set(["MID", ...(preferences.get().pairs || [])
        .map((pair) => pair.saved).filter((field) => field !== null)]);
      results.replaceChildren(...matches.slice(0, 30).map((record) =>
        el("div", { class: "workspace-actions" }, el("button", { onclick: async () => {
          const current = store.state().datasets.find((file) => file.id === ds.id);
          const currentRow = current?.records.find((item) => item.id === row.id);
          if (!currentRow || current.generation !== ds.generation) {
            notify("This file changed. Reopen the Aftersales row.");
            close();
            return;
          }
          if (await savePreferences("links", key, String(record.id), existing))
            recordDialog(current, currentRow);
        } }, record.name), el("small", {}, [...identifyingFields]
          .filter((field) => record.details?.[field])
          .map((field) => `${field}: ${record.details[field]}`)
          .concat(positionOf(record) ? "Has coordinates" : "Missing coordinates").join(" · ")))),
        el("p", {}, matches.length > 30 ? "Showing 30 matches. Refine your search." :
          matches.length ? "" : "No matching Saved Records."));
    }
    modal("Link to Saved Record", el("div", {}, search, results,
      el("button", { onclick: () => recordDialog(ds, row) }, "Back to record")));
    draw();
    search.focus();
  }
  function importFiles(kind, files) {
    Promise.all(
      [...files].map(async (file) => {
        const bytes = await file.arrayBuffer(),
          book = XLSX.read(bytes, { type: "array", cellStyles: true });
        const parsed = A.parseSheet(XLSX, book.Sheets[book.SheetNames[0]], {
          ...T.options(kind),
          blankValue: "",
          preserveFields: true,
          aftersalesLocation: kind === "aftersales",
        });
        if (!parsed.rows.length) throw Error(`${file.name}: no data rows`);
        return {
          filename: file.name,
          headers: parsed.headers,
          records: parsed.rows.map((r) => ({
            id: crypto.randomUUID(),
            ...r,
          })),
        };
      }),
    )
      .then((parsed) => {
        const ds = store
          .state()
          .datasets.find((d) => d.id === views[kind].selected);
        const choice = el(
          "select",
          {},
          el("option", { value: "add" }, "Add as separate new file(s)"),
          el(
            "option",
            { value: "replace", disabled: !ds || parsed.length !== 1 },
            "Replace selected file",
          ),
        );
        const text = el(
          "p",
          {},
          `${parsed.length} file(s) ready. Replacing affects only the selected file. Other datasets remain unchanged.`,
        );
        modal(
          "Upload " + title(kind),
          el(
            "div",
            {},
            text,
            choice,
            el(
              "button",
              {
                class: "primary",
                onclick: () => {
                  if (choice.value === "replace") {
                    if (
                      !confirm(
                        `Replace ${ds.name} (${ds.records.length} records) with ${parsed[0].filename} (${parsed[0].records.length} records)?`,
                      )
                    )
                      return;
                    add([
                      {
                        kind: "replace_dataset",
                        id: ds.id,
                        generation: ds.generation,
                        expectedRecords: ds.records,
                        expectedHeaders: ds.headers,
                        ...parsed[0],
                      },
                    ]);
                  } else {
                    const actions = parsed.map((p) => ({
                      kind: "create_dataset",
                      id: crypto.randomUUID(),
                      datasetKind: kind,
                      name: p.filename,
                      ...p,
                    }));
                    views[kind].selected = actions[0].id;
                    add(actions);
                  }
                  close();
                },
              },
              "Confirm upload",
            ),
          ),
        );
      })
      .catch((error) => notify("File not loaded: " + error.message));
  }
  function mergeDialog(kind) {
    const datasets = store.state().datasets.filter((d) => d.kind === kind),
      checks = [];
    const name = el("input", {
      type: "text",
      maxLength: 250,
      value: `Merged ${title(kind)}.xlsx`,
      "aria-label": "New merged filename",
    });
    const preview = el(
      "p",
      { "data-testid": "merge-preview" },
      "Select at least two synced files. Newer upload has priority; originals are kept.",
    );
    const boxes = datasets.map((d) => {
      const check = el("input", {
        type: "checkbox",
        disabled: d.uploadOrder == null,
        onchange: update,
      });
      checks.push({ check, d });
      return el(
        "label",
        { class: "workspace-check" },
        check,
        `${d.name}${d.uploadOrder == null ? " (sync first)" : ""}`,
      );
    });
    let selected = [];
    function update() {
      selected = checks.filter((x) => x.check.checked).map((x) => x.d);
      if (selected.length < 2) {
        preview.textContent = "Select at least two files.";
        return;
      }
      const merged = T.merge(selected);
      const newest = [...selected].sort((a, b) =>
        BigInt(a.uploadOrder) > BigInt(b.uploadOrder) ? -1 : 1,
      );
      preview.textContent = `${selected.reduce((n, d) => n + d.records.length, 0)} source rows → ${merged.records.length} unique rows. Priority: ${newest.map((d) => d.name).join(" → ")} (newest first). Every business value must match exactly.`;
    }
    modal(
      "Merge into a NEW file",
      el(
        "div",
        {},
        boxes,
        name,
        preview,
        el(
          "button",
          {
            class: "primary",
            onclick: () => {
              update();
              if (selected.length < 2) return;
              const filename = A.filename(name.value);
              if (!name.value.trim()) return;
              const merged = T.merge(selected),
                id = crypto.randomUUID();
              add([
                {
                  kind: "merge_datasets",
                  id,
                  datasetKind: kind,
                  name: filename,
                  sources: selected.map((d) => ({
                    id: d.id,
                    headers: d.headers,
                    records: d.records,
                    uploadOrder: d.uploadOrder,
                  })),
                  optimistic: {
                    id,
                    kind,
                    name: filename,
                    filename,
                    ...merged,
                    generation: "0",
                    revision: "0",
                    uploadOrder: null,
                  },
                },
              ]);
              views[kind].selected = id;
              close();
            },
          },
          "Create merged file",
        ),
      ),
    );
  }
  function copyRecord(ds, row) {
    navigator.clipboard
      .writeText(
        ds.headers.map((h) => `${h}: ${row.details[h] ?? ""}`).join("\n"),
      )
      .catch(() => notify("Clipboard unavailable"));
  }
  let selectedFilters = {};
  try {
    selectedFilters = JSON.parse(
      localStorage.getItem("maya-file-field-filters") || "{}",
    );
    if (
      !selectedFilters ||
      Array.isArray(selectedFilters) ||
      typeof selectedFilters !== "object"
    )
      selectedFilters = {};
  } catch {}
  function chooseFilter(id, value) {
    selectedFilters[id] = value;
    try {
      localStorage.setItem(
        "maya-file-field-filters",
        JSON.stringify(selectedFilters),
      );
    } catch {}
  }
  function recordDialog(initial, initialRow) {
    let editing = null,
      draft = "";
    const body = el("div");
    const message = el("p", { role: "status", class: "field-feedback" });
    const copy = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        message.textContent = "Copied";
      } catch {
        message.textContent =
          "Copy unavailable. Please allow clipboard access.";
      }
    };
    function draw() {
      const ds = store.state().datasets.find((d) => d.id === initial.id);
      const row = ds?.records.find(
        (r) => String(r.id) === String(initialRow.id),
      );
      if (!row || ds.generation !== initial.generation) {
        body.replaceChildren(
          el(
            "p",
            {},
            "This file was replaced or deleted. Close and reopen the record.",
          ),
        );
        return;
      }
      const shared = ds.kind === "aftersales";
      const filters = shared ? sharedFilters() : ds.filters || {};
      const selected = shared ? preferences.get().selectedFilter ?? selectedFilters[ds.id] : selectedFilters[ds.id];
      const active = filters[selected];
      const linked = shared ? matchRows(ds)(row) : null;
      const fields = active
        ? ds.headers.filter((h) => active.fields.includes(h))
        : ds.headers;
      const picker = el(
        "select",
        {
          "aria-label": "Field filter",
          "data-local-preference": "",
          disabled: !!editing,
          onchange: (e) => {
            if (shared) {
              const id = e.target.value;
              try { preferences.select(id); } catch (error) { notify(error.message); }
            } else chooseFilter(ds.id, e.target.value);
            draw();
          },
        },
        el("option", { value: "", selected: !active }, "All fields"),
        Object.entries(filters).map(([id, f]) =>
          el(
            "option",
            { value: id, selected: selected === id },
            f.name,
          ),
        ),
      );
      const missing =
        active?.fields.filter((h) => !ds.headers.includes(h)) || [];
      body.replaceChildren(
        el(
          "div",
          { class: "workspace-toolbar" },
          picker,
          el(
            "button",
            {
              disabled: !!editing || (!shared && !store.state().fieldFiltersEnabled),
              onclick: () => (shared ? manageSharedFilters : manageFilters)(ds, () => recordDialog(ds, row)),
            },
            "Manage filters",
          ),
        ),
        shared ? el("div", { class: "workspace-actions" },
          el("span", {}, linked ? `Linked to ${linked.name}${positionOf(linked) ? "" : " · Missing coordinates"}` : "Needs matching"),
          el("button", { disabled: !!editing, onclick: () => linkDialog(ds, row) },
            linked ? "Change Saved Record link" : "Link to Saved Record")) : null,
        ...(!shared && !store.state().fieldFiltersEnabled
          ? [
              el(
                "p",
                {},
                "Saved field filters require SQL upgrade 10. Existing records remain available.",
              ),
            ]
          : []),
        ...(missing.length
          ? [
              el(
                "p",
                { role: "status" },
                "Filter needs review — missing columns: " + missing.join(", "),
              ),
            ]
          : []),
        ...fields.map((header) => {
          const field = el(
            "div",
            { class: "workspace-read-field" },
            el("strong", {}, header),
          );
          if (editing === header) {
            const input = el("input", {
              value: draft,
              "aria-label": header,
              oninput: (e) => (draft = e.target.value),
            });
            field.append(
              input,
              el(
                "div",
                { class: "workspace-actions" },
                el(
                  "button",
                  {
                    onclick: () => {
                      const latest = store
                        .state()
                        .datasets.find((d) => d.id === ds.id);
                      if (!latest || latest.generation !== ds.generation) {
                        message.textContent =
                          "File replaced or deleted. Reopen the record.";
                        return;
                      }
                      if (draft !== String(row.details[header] ?? ""))
                        add([
                          {
                            kind: "patch_record",
                            id: ds.id,
                            generation: ds.generation,
                            recordId: String(row.id),
                            fields: { [header]: draft },
                            beforeRecord: row,
                          },
                        ]);
                      editing = null;
                      dialog.dataset.dirty = "false";
                      draw();
                    },
                  },
                  "Save",
                ),
                el(
                  "button",
                  {
                    onclick: () => {
                      editing = null;
                      dialog.dataset.dirty = "false";
                      draw();
                    },
                  },
                  "Cancel",
                ),
              ),
            );
          } else
            field.append(
              el(
                "button",
                {
                  class: "copy-field-value",
                  "aria-label": "Copy " + header,
                  onclick: () => copy(String(row.details[header] ?? "")),
                },
                String(row.details[header] ?? "") || "—",
              ),
              el(
                "button",
                {
                  "aria-label": "Edit " + header,
                  disabled: !!editing,
                  onclick: () => {
                    editing = header;
                    draft = String(row.details[header] ?? "");
                    draw();
                  },
                },
                "✎",
              ),
            );
          return field;
        }),
        message,
        el(
          "div",
          { class: "workspace-actions" },
          el(
            "button",
            {
              onclick: () =>
                copy(
                  ds.headers
                    .map((h) => `${h}: ${row.details[h] ?? ""}`)
                    .join("\n"),
                ),
            },
            "Copy all fields",
          ),
          el(
            "button",
            {
              onclick: () =>
                copy(
                  fields.map((h) => `${h}: ${row.details[h] ?? ""}`).join("\n"),
                ),
            },
            "Copy filtered fields",
          ),
        ),
      );
    }
    modal(nameOf(initialRow, initial.headers), body);
    draw();
  }
  function manageSharedFilters(initial, back) {
    const body = el("div");
    function list() {
      if (dialog) dialog.dataset.dirty = "false";
      const savedFilters = preferences.get().filters;
      body.replaceChildren(
        ...Object.entries(sharedFilters()).map(([id, filter]) => el("div", { class: "workspace-actions" },
          el("span", {}, filter.name), el("button", { onclick: () => edit(id, filter, savedFilters?.[id]) }, "Edit / rename"),
          el("button", { onclick: async () => {
            if (confirm(`Delete filter ${filter.name}?`) &&
              await savePreferences("filters", id, null, savedFilters?.[id])) list();
          } }, "Delete filter"))),
        el("button", { onclick: () => edit(crypto.randomUUID()) }, "Add filter"),
        el("button", { onclick: back }, "Back to record"));
    }
    function edit(id, filter, existing) {
      const name = el("input", { "aria-label": "Filter name", value: filter?.name || "", maxLength: 80 });
      const headers = new Set([...initial.headers, ...(filter?.fields || []),
        ...store.state().datasets.filter((ds) => ds.kind === "aftersales").flatMap((ds) => ds.headers)]);
      const checks = [...headers].map((header) => [header,
        el("input", { type: "checkbox", checked: filter?.fields.includes(header) || false })]);
      const notice = el("p", { role: "status" });
      body.replaceChildren(name, ...checks.map(([header, check]) => el("label", { class: "workspace-check" }, check, header)),
        notice, el("button", { onclick: async () => {
          const fields = checks.filter(([, check]) => check.checked).map(([header]) => header);
          if (!name.value.trim() || !fields.length) {
            notice.textContent = "Enter a name and choose at least one column.";
            return;
          }
          if (await savePreferences("filters", id, { name: name.value.trim(), fields }, existing)) {
            try { preferences.select(id); } catch (error) { notify(error.message); }
            list();
          }
        } }, "Save filter"), el("button", { onclick: list }, "Cancel"));
    }
    modal(preferences.shared() ? "Manage shared Aftersales filters" : "Manage Aftersales filters (this browser)", body);
    list();
  }
  function manageFilters(initial, back) {
    const body = el("div"),
      notice = el("p", { role: "status" });
    const ds = () => store.state().datasets.find((d) => d.id === initial.id);
    function edit(id) {
      const current = ds();
      if (!current || current.generation !== initial.generation) {
        notice.textContent = "File changed. Reopen it.";
        return;
      }
      const previous = current.filters?.[id] || null;
      const name = el("input", {
        "aria-label": "Filter name",
        maxLength: 80,
        value: previous?.name || "",
      });
      const checks = [
        ...new Set([...current.headers, ...(previous?.fields || [])]),
      ].map((h) => ({
        h,
        input: el("input", {
          type: "checkbox",
          checked: previous?.fields.includes(h) || false,
        }),
      }));
      body.replaceChildren(
        el("label", { class: "workspace-field" }, "Filter name", name),
        ...checks.map(({ h, input }) =>
          el(
            "label",
            { class: "workspace-check" },
            input,
            h +
              (current.headers.includes(h)
                ? ""
                : " (missing column — uncheck to remove)"),
          ),
        ),
        notice,
        el(
          "button",
          {
            onclick: () => {
              const fields = checks
                .filter((x) => x.input.checked)
                .map((x) => x.h);
              if (
                !name.value.trim() ||
                !fields.length ||
                fields.some((h) => !current.headers.includes(h))
              ) {
                notice.textContent =
                  "Enter a name and select existing columns.";
                return;
              }
              add([
                {
                  kind: "set_filter",
                  id: current.id,
                  generation: current.generation,
                  filterId: id,
                  expectedFilter: previous,
                  filter: { name: name.value.trim(), fields },
                },
              ]);
              list();
            },
          },
          "Save filter",
        ),
        el("button", { onclick: list }, "Cancel"),
      );
    }
    function list() {
      if (dialog) dialog.dataset.dirty = "false";
      const current = ds();
      if (!current || current.generation !== initial.generation) {
        body.replaceChildren(el("p", {}, "File changed. Close and reopen."));
        return;
      }
      body.replaceChildren(
        ...Object.entries(current.filters || {}).map(([id, f]) =>
          el(
            "div",
            { class: "workspace-actions" },
            el("span", {}, f.name),
            el("button", { onclick: () => edit(id) }, "Edit / rename"),
            el(
              "button",
              {
                onclick: () => {
                  if (
                    confirm(
                      `Delete filter ${f.name}? Records remain unchanged.`,
                    )
                  ) {
                    add([
                      {
                        kind: "delete_filter",
                        id: current.id,
                        generation: current.generation,
                        filterId: id,
                        expectedFilter: f,
                      },
                    ]);
                    list();
                  }
                },
              },
              "Delete filter",
            ),
          ),
        ),
        el(
          "button",
          { onclick: () => edit(crypto.randomUUID()) },
          "Add filter",
        ),
        el("button", { onclick: back }, "Back to record"),
      );
    }
    modal("Manage filters for " + initial.name, body);
    list();
  }
  function deleteFile(ds) {
    if (
      confirm(
        `Delete ${ds.name} (${ds.records.length} records)? Only this file will be removed on all synced devices. Export a backup first if needed.`,
      )
    )
      add([
        {
          kind: "delete_dataset",
          id: ds.id,
          generation: ds.generation,
          expectedRecords: ds.records,
          expectedHeaders: ds.headers,
        },
      ]);
  }
  function visible(ds, view, needsReview) {
    const query = view.query.trim().toLowerCase();
    return ds.records.filter(
      (r) =>
        (view.mapReview && needsReview ? needsReview(r) :
          (ds.kind === "visits"
          ? T.normalizeVisit(r.status)
          : A.normalizeStatus(r.status)) === view.mode) &&
        (!query ||
          Object.values(r.details || {}).some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(query),
          )),
    );
  }
  function card(ds, row, mapIssue) {
    const status =
      ds.kind === "visits"
        ? T.normalizeVisit(row.status)
        : A.normalizeStatus(row.status);
    const buttons = (
      ds.kind === "visits" ? ["Visited"] : ["Resolved", "Unresolved"]
    ).map((marker) =>
      el(
        "button",
        {
          "data-marker": marker,
          onclick: () =>
            add([
              {
                kind: "set_marker",
                id: ds.id,
                generation: ds.generation,
                recordId: String(row.id),
                status: status === marker ? "None" : marker,
                beforeRecord: row,
              },
            ]),
        },
        marker + (status === marker ? " ✓" : ""),
      ),
    );
    return el(
      "article",
      {
        class: "workspace-card status-" + status.toLowerCase(),
        "data-record-id": String(row.id),
      },
      el(
        "div",
        {},
        el(
          "div",
          { class: "workspace-card-heading" },
          el(
            "strong",
            { class: "desktop-record-name" },
            nameOf(row, ds.headers),
          ),
          ...[
            el(
              "button",
              {
                class: "phone-record-name",
                onclick: () => recordDialog(ds, row),
                "aria-label": "Open record " + nameOf(row, ds.headers),
              },
              nameOf(row, ds.headers),
            ),
          ],
          el(
            "small",
            {},
            status === "None"
              ? ds.kind === "visits"
                ? "Not visited"
                : "Unmarked"
              : status,
          ),
          mapIssue ? el("small", {}, mapIssue) : null,
        ),
        el(
          "p",
          {},
          ds.headers
            .slice(0, 2)
            .map((k) => `${k}: ${row.details[k] ?? ""}`)
            .join(" · "),
        ),
      ),
      el(
        "div",
        { class: "workspace-actions" },
        buttons,
        el(
          "button",
          {
            class: "desktop-record-action",
            onclick: () => recordDialog(ds, row),
          },
          "Open record",
        ),
        el(
          "button",
          {
            class: "desktop-record-action",
            onclick: () => copyRecord(ds, row),
          },
          "Copy",
        ),
      ),
    );
  }
  function render(force = false) {
    document
      .querySelectorAll("[data-workspace-status]")
      .forEach((n) => (n.textContent = store.status()));
    if (dialog) return;
    const state = store.state(),
      signature = JSON.stringify([
        state.datasets,
      state.aftersalesSetup,
        store.ready(),
        store.blocked(),
      ]);
    if (!force && signature === last) return;
    last = signature;
    for (const kind of ["aftersales", "visits"]) {
      const host = hosts[kind],
        view = views[kind],
        datasets = state.datasets.filter((d) => d.kind === kind);
      if (!datasets.some((d) => d.id === view.selected))
        view.selected = datasets[0]?.id || "";
      const ds = datasets.find((d) => d.id === view.selected);
      const active = document.activeElement;
      const focus = host.contains(active) ? active.dataset.focus : null;
      const caret = focus ? active.selectionStart : null;
      const select = el(
        "select",
        {
          "aria-label": title(kind) + " file",
          value: view.selected,
          onchange: (e) => {
            view.selected = e.target.value;
            render(true);
          },
        },
        datasets.map((d) =>
          el(
            "option",
            { value: d.id, selected: d.id === view.selected },
            `${d.name}${d.uploadOrder == null ? " · Pending upload" : ""}`,
          ),
        ),
      );
      const file = el("input", {
        type: "file",
        accept: ".xlsx,.xls",
        multiple: true,
        hidden: true,
        onchange: (e) => {
          if (e.target.files.length) importFiles(kind, e.target.files);
          e.target.value = "";
        },
      });
      const mode = el(
        "button",
        {
          "data-testid": "dataset-status-filter",
          onclick: () => {
            const modes =
              kind === "visits"
                ? ["None", "Visited"]
                : ["None", "Resolved", "Unresolved"];
            view.mode = modes[(modes.indexOf(view.mode) + 1) % modes.length];
            render(true);
          },
        },
        view.mode === "None"
          ? kind === "visits"
            ? "Not visited"
            : "Default"
          : view.mode,
      );
      const search = el("input", {
        type: "search",
        placeholder: "Search this file…",
        value: view.query,
        "data-focus": "search",
        "aria-label": title(kind) + " search",
        oninput: (e) => {
          view.query = e.target.value;
          render(true);
        },
      });
      const match = ds?.kind === "aftersales" ? matchRows(ds) : null;
      const coordinate = match ? coordinateField() : null;
      const issues = new Map();
      if (match) for (const row of ds.records) {
        const linked = match(row);
        if (!linked) issues.set(row.id, "Needs matching");
        else if (!positionOf(linked, coordinate)) issues.set(row.id, "Missing coordinates");
      }
      const needsReview = (row) => issues.has(row.id);
      const records = ds ? visible(ds, view, needsReview) : [];
      const exportMenu = el(
        "details",
        { class: "workspace-export" },
        el("summary", {}, "Export"),
        el(
          "div",
          {},
          ["all", "view"].map((scope) =>
            el(
              "button",
              {
                disabled:
                  !ds || !(scope === "all" ? ds.records : records).length,
                onclick: () => {
                  const selected =
                    scope === "all" ? ds.records : records;
                  const matchLatest = match ? matchRows(ds) : null;
                  const currentField = matchLatest ? coordinateField() : null;
                  const rows = matchLatest ? selected.map((row) => {
                    const linked = matchLatest(row);
                    if (!linked) return row;
                    return { ...row, linkedRecordId: String(linked.id),
                      coordinateSnapshot: positionOf(linked, currentField)?.join(", ") || "" };
                  }) : selected;
                  const book = A.makeWorkbook(XLSX, ds.headers, rows, {
                    ...T.options(kind),
                    preserveFields: true,
                    aftersalesLocation: kind === "aftersales",
                  });
                  XLSX.writeFile(book, A.filename(ds.filename));
                  exportMenu.open = false;
                },
              },
              scope === "all" ? "Export all" : "Export current view",
            ),
          ),
        ),
      );
      const content = el(
        "section",
        {
          class: "workspace-panel compact-aftersales",
        },
        el(
          "header",
          {},
          el("h2", {}, title(kind)),
          el(
            "p",
            { "data-workspace-status": "", role: "status" },
            store.status(),
          ),
        ),
        file,
        el(
          "div",
          { class: "workspace-toolbar" },
          select,
          (() => {
            const actions = el(
              "div",
              { class: "file-action-items" },
              el(
                "button",
                { disabled: !store.ready(), onclick: () => file.click() },
                "Upload Excel",
              ),
              el(
                "button",
                { disabled: !ds, onclick: () => deleteFile(ds) },
                "Delete file",
              ),
              el(
                "button",
                {
                  disabled: datasets.length < 2,
                  onclick: () => mergeDialog(kind),
                },
                "Merge files",
              ),
              exportMenu,
            );
            const toggle = el(
              "button",
              {
                class: "phone-file-actions",
                "aria-expanded": "false",
                onclick: () => {
                  const expanded =
                    toggle.getAttribute("aria-expanded") !== "true";
                  toggle.setAttribute("aria-expanded", String(expanded));
                  actions.classList.toggle("phone-actions-open", expanded);
                },
              },
              "File actions ▾",
            );
            return el("div", { class: "file-action-menu" }, toggle, actions);
          })(),
        ),
        el(
          "div",
          { class: "workspace-toolbar" },
          mode,
          search,
          match ? el("button", { onclick: matchSettings }, "Matching rules") : null,
          match ? el("button", { class: view.mapReview ? "primary" : "",
            "aria-pressed": String(!!view.mapReview), onclick: () => {
            view.mapReview = !view.mapReview;
            render(true);
          } }, `Map review (${issues.size})`) : null,
          el(
            "small",
            {},
            `${records.length} / ${ds?.records.length || 0} records`,
          ),
        ),
        el(
          "div",
          { class: "workspace-records" },
          records.length
            ? records.map((r) => card(ds, r, issues.get(r.id)))
            : el(
                "p",
                {},
                ds
                  ? "No matching records."
                  : "No files loaded on this device. Connect to load existing files, or add a new file.",
              ),
        ),
        el(
          "details",
          {},
          el("summary", {}, "File management & recovery"),
          el(
            "div",
            { class: "workspace-actions" },
            el("button", { onclick: () => store.sync() }, "Sync files now"),
            kind === "aftersales" && preferences.shared()
              ? el("button", { onclick: importSetup }, "Import this browser’s Aftersales setup") : null,
            el(
              "button",
              {
                onclick: () =>
                  download(
                    store.backup(),
                    "Project-Maya-datasets-recovery.json",
                  ),
              },
              "Download dataset backup",
            ),
            el(
              "button",
              {
                disabled: !store.blocked(),
                onclick: () => store.discardBlocked(),
              },
              "Review / discard blocked action",
            ),
          ),
        ),
      );
      host.replaceChildren(content);
      if (focus) {
        const next = host.querySelector(`[data-focus="${focus}"]`);
        next?.focus();
        if (next?.setSelectionRange && caret != null)
          next.setSelectionRange(caret, caret);
      }
    }
  }
  window.addEventListener("beforeunload", (event) => {
    if (dialog?.dataset.dirty === "true") {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  store.subscribe(() => render());
  render(true);
  return { refresh: () => render(true) };
};
