window.createDatasetWorkspace = function ({ store, hosts }) {
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
    dialog.addEventListener("input", () => (dialog.dataset.dirty = "true"));
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
  function importFiles(kind, files) {
    Promise.all(
      [...files].map(async (file) => {
        const bytes = await file.arrayBuffer(),
          book = XLSX.read(bytes, { type: "array", cellStyles: true });
        const parsed = A.parseSheet(XLSX, book.Sheets[book.SheetNames[0]], {
          ...T.options(kind),
          blankValue: "",
          preserveFields: true,
        });
        if (!parsed.rows.length) throw Error(`${file.name}: no data rows`);
        return {
          filename: file.name,
          headers: parsed.headers,
          records: parsed.rows.map((r) => ({
            id: crypto.randomUUID(),
            details: r.details,
            status: r.status,
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
  function recordDialog(ds, row) {
    const inputs = ds.headers.map((header) => ({
      header,
      input: el("input", {
        type: "text",
        value: String(row.details[header] ?? ""),
        "aria-label": header,
      }),
    }));
    modal(
      nameOf(row, ds.headers),
      el(
        "div",
        {},
        inputs.map(({ header, input }) =>
          el(
            "label",
            { class: "workspace-field" },
            el("span", {}, header),
            input,
          ),
        ),
        el(
          "button",
          {
            class: "primary",
            onclick: () => {
              const fields = Object.fromEntries(
                inputs
                  .filter(
                    ({ header, input }) =>
                      input.value !== String(row.details[header] ?? ""),
                  )
                  .map(({ header, input }) => [header, input.value]),
              );
              if (Object.keys(fields).length)
                add([
                  {
                    kind: "patch_record",
                    id: ds.id,
                    generation: ds.generation,
                    recordId: String(row.id),
                    fields,
                    beforeRecord: row,
                  },
                ]);
              close();
            },
          },
          "Save changed fields",
        ),
      ),
    );
  }
  function visible(ds, view) {
    const query = view.query.trim().toLowerCase();
    return ds.records.filter(
      (r) =>
        (ds.kind === "visits"
          ? T.normalizeVisit(r.status)
          : A.normalizeStatus(r.status)) === view.mode &&
        (!query ||
          Object.values(r.details || {}).some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(query),
          )),
    );
  }
  function card(ds, row) {
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
        el("strong", {}, nameOf(row, ds.headers)),
        el(
          "small",
          {},
          status === "None"
            ? ds.kind === "visits"
              ? "Not visited"
              : "Unmarked"
            : status,
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
        el("button", { onclick: () => recordDialog(ds, row) }, "Open / edit"),
        el(
          "button",
          {
            onclick: () =>
              navigator.clipboard
                .writeText(
                  ds.headers
                    .map((h) => `${h}: ${row.details[h] ?? ""}`)
                    .join("\n"),
                )
                .catch(() => notify("Clipboard unavailable")),
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
      const records = ds ? visible(ds, view) : [];
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
                    scope === "all" ? ds.records : visible(ds, view);
                  const book = A.makeWorkbook(XLSX, ds.headers, selected, {
                    ...T.options(kind),
                    preserveFields: true,
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
        { class: "workspace-panel" },
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
          el(
            "button",
            { disabled: !store.ready(), onclick: () => file.click() },
            "Upload Excel",
          ),
          el(
            "button",
            { disabled: datasets.length < 2, onclick: () => mergeDialog(kind) },
            "Merge files",
          ),
          exportMenu,
        ),
        el(
          "div",
          { class: "workspace-toolbar" },
          mode,
          search,
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
            ? records.map((r) => card(ds, r))
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
                disabled: !ds,
                onclick: () => {
                  if (
                    confirm(
                      `Delete only ${ds.name}? Other files remain unchanged.`,
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
                },
              },
              "Delete selected file",
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
