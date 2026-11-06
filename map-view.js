window.createMayaMap = function ({
  host,
  store,
  getState,
  openRecord,
  visitedToday,
}) {
  const M = window.MayaMapModel;
  let map,
    layer,
    tile,
    opening = false,
    active = false,
    query = "",
    filter = "all",
    fit = false,
    tileFailed = false,
    libraryError = "",
    dialog,
    lastSignature = "";
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
  const search = el("input", {
    type: "search",
    placeholder: "Search map records…",
    "aria-label": "Search map records",
    oninput: (e) => {
      query = e.target.value;
      refresh(true);
    },
  });
  const select = el(
    "select",
    {
      "aria-label": "Visit filter",
      onchange: (e) => {
        filter = e.target.value;
        refresh(true);
      },
    },
    [
      ["all", "All locations"],
      ["recent", "Recently visited"],
      ["due", "Due soon"],
      ["overdue", "Overdue"],
      ["unvisited", "No visit date"],
      ["invalid", "Needs correction"],
    ].map(([value, text]) => el("option", { value }, text)),
  );
  const info = el("p", { role: "status", class: "map-message" }),
    legend = el("div", { class: "map-legend" }),
    canvas = el("div", {
      id: "maya-map-canvas",
      "aria-label": "Saved record locations",
    }),
    list = el("div", { class: "map-record-list" });
  const recordsPanel = el(
    "details",
    { class: "map-record-panel", open: true },
    el("summary", {}, "Records & coordinate corrections"),
    list,
  );
  host.append(
    el(
      "section",
      { class: "map-panel" },
      el("h2", {}, "Saved Records Map"),
      el(
        "div",
        { class: "workspace-toolbar" },
        search,
        select,
        el(
          "button",
          {
            onclick: () => {
              if (map) fitAll();
            },
          },
          "Fit locations",
        ),
        el("button", { onclick: settingsDialog }, "Map settings"),
      ),
      legend,
      info,
      canvas,
      recordsPanel,
    ),
  );
  function settings() {
    return store.state().mapSettings;
  }
  function matching() {
    const s = getState();
    return M.points(s.establishments, s.customFields, settings()).filter(
      (p) =>
        (!query ||
          [p.record.name, ...Object.values(p.record.details || {})].some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(query.toLowerCase()),
          )) &&
        (filter === "all" ||
          (filter === "invalid"
            ? p.coordinateError || ["invalid", "future"].includes(p.category)
            : p.category === filter)),
    );
  }
  function fitAll() {
    const valid = matching().filter((p) => p.position);
    if (valid.length) {
      map.fitBounds(
        valid.map((p) => p.position),
        { padding: [30, 30], maxZoom: 15 },
      );
      fit = true;
    }
  }
  function actions(point) {
    const record = point.record;
    return el(
      "div",
      { class: "workspace-actions" },
      el("button", { onclick: () => openRecord(record.id) }, "Open record"),
      el(
        "button",
        {
          disabled: point.age === 0,
          onclick: () => {
            try {
              visitedToday(record.id);
              refresh(true);
            } catch (error) {
              window.alert(error.message);
            }
          },
        },
        point.age === 0 ? "Visited today ✓" : "Visited today",
      ),
      point.position
        ? el(
            "a",
            {
              href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(point.position.join(","))}`,
              target: "_blank",
              rel: "noopener noreferrer",
            },
            "Navigate with Google Maps",
          )
        : null,
    );
  }
  function popup(point) {
    return el(
      "div",
      {},
      el("strong", {}, point.record.name),
      el("p", {}, point.label),
      actions(point),
    );
  }
  function renderPins(points) {
    if (!map) return;
    layer.clearLayers();
    const groups = new Map();
    for (const p of points.filter((p) => p.position)) {
      const pixel = map.project(p.position, map.getZoom()),
        key = `${Math.floor(pixel.x / 56)},${Math.floor(pixel.y / 56)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      const pos = [
        group.reduce((n, p) => n + p.position[0], 0) / group.length,
        group.reduce((n, p) => n + p.position[1], 0) / group.length,
      ];
      if (group.length === 1) {
        const p = group[0];
        L.circleMarker(p.position, {
          radius: 9,
          color: "#fff",
          weight: 2,
          fillColor: p.color,
          fillOpacity: 1,
        })
          .addTo(layer)
          .bindPopup(() => popup(p));
      } else {
        const marker = L.marker(pos, {
          title: `${group.length} locations`,
          icon: L.divIcon({
            className: "map-cluster",
            html: String(group.length),
            iconSize: [36, 36],
          }),
        }).addTo(layer);
        marker.on("click", () => {
          const bounds = L.latLngBounds(group.map((p) => p.position));
          if (map.getZoom() >= 18) {
            marker
              .bindPopup(
                el(
                  "div",
                  { class: "map-overlap-list" },
                  group.map((p) => popup(p)),
                ),
              )
              .openPopup();
          } else if (bounds.getNorthEast().equals(bounds.getSouthWest()))
            map.setView(pos, Math.min(18, map.getZoom() + 2));
          else map.fitBounds(bounds, { padding: [35, 35], maxZoom: 18 });
        });
      }
    }
  }
  function refresh(force = false) {
    if (!active) return;
    const data = getState(),
      s = settings(),
      key = JSON.stringify([
        data.establishments,
        data.customFields,
        s,
        query,
        filter,
        M.today(),
      ]);
    if (!force && key === lastSignature) return;
    lastSignature = key;
    const keys = M.bindings(data.customFields, s),
      points = matching(),
      bad = points.filter((p) => p.coordinateError).length;
    legend.replaceChildren(
      ...[
        ["recent", `0–${s.greenDays} days`],
        ["due", `${s.greenDays + 1}–${s.orangeDays} days`],
        ["overdue", `Over ${s.orangeDays} days`],
        ["unvisited", "No visit date"],
        ["invalid", "Check date / coordinates"],
      ].map(([c, text]) =>
        el("span", {}, el("i", { style: `background:${M.COLORS[c]}` }), text),
      ),
    );
    info.textContent = libraryError
      ? libraryError
      : !keys.coordinate || !keys.visit
        ? "Choose the coordinate and LAST VISIT fields in Map settings."
        : tileFailed
          ? "Map background unavailable. Records, pins, and local visit updates remain available."
          : `${points.filter((p) => p.position).length} mapped · ${bad} missing/invalid coordinates. Visit ranges use Philippine dates. Map backgrounds need internet.`;
    list.replaceChildren(
      ...(points.length
        ? points.slice(0, 100).map((p) =>
            el(
              "article",
              { class: "map-record" },
              el("strong", {}, p.record.name),
              el(
                "small",
                {},
                p.coordinateError ? "Missing/invalid coordinates" : p.label,
              ),
              el(
                "div",
                { class: "workspace-actions" },
                p.position
                  ? el(
                      "button",
                      {
                        onclick: () => {
                          map?.setView(p.position, 17);
                        },
                      },
                      "Locate",
                    )
                  : null,
                actions(p),
              ),
            ),
          )
        : [el("p", {}, "No matching records.")]),
    );
    if (points.length > 100)
      list.append(
        el(
          "p",
          {},
          `Showing 100 of ${points.length}. Search to narrow the list; all matching locations remain on the map.`,
        ),
      );
    renderPins(points);
    if (map && !fit) fitAll();
  }
  function settingsDialog() {
    const s = settings(),
      fields = getState().customFields,
      keys = M.bindings(fields, s),
      green = el("input", {
        type: "number",
        min: 0,
        max: 3649,
        value: s.greenDays,
        "aria-label": "Green cutoff days",
      }),
      orange = el("input", {
        type: "number",
        min: 1,
        max: 3650,
        value: s.orangeDays,
        "aria-label": "Orange cutoff days",
      });
    const coords = el(
      "select",
      { "aria-label": "Coordinate field" },
      fields.map((f) =>
        el(
          "option",
          {
            value: f.key,
            selected: f.key === (keys.coordinate?.key || s.coordinateKey),
          },
          f.key,
        ),
      ),
    );
    const dates = el(
      "select",
      { "aria-label": "Last visit date field" },
      fields
        .filter((f) => f.type === "date")
        .map((f) =>
          el(
            "option",
            {
              value: f.key,
              selected: f.key === (keys.visit?.key || s.visitKey),
            },
            f.key,
          ),
        ),
    );
    const message = el("p", { role: "status" });
    dialog = el(
      "dialog",
      { class: "workspace-dialog", "aria-label": "Map settings" },
      el("h3", {}, "Map settings (shared across devices)"),
      el("label", { class: "workspace-field" }, "Coordinate field", coords),
      el("label", { class: "workspace-field" }, "LAST VISIT date field", dates),
      el(
        "label",
        { class: "workspace-field" },
        "Green: up to this many days",
        green,
      ),
      el(
        "label",
        { class: "workspace-field" },
        "Orange: up to this many days",
        orange,
      ),
      message,
      el(
        "button",
        {
          class: "primary",
          onclick: () => {
            const a = Number(green.value),
              b = Number(orange.value);
            if (
              !Number.isInteger(a) ||
              !Number.isInteger(b) ||
              a < 0 ||
              b <= a ||
              b > 3650 ||
              !coords.value ||
              !dates.value
            ) {
              message.textContent =
                "Choose fields and whole-number cutoffs with 0 ≤ green < orange ≤ 3650.";
              return;
            }
            if (!store.ready()) {
              message.textContent = "Device workspace storage is not ready.";
              return;
            }
            store.add([
              {
                kind: "map_settings",
                settings: {
                  greenDays: a,
                  orangeDays: b,
                  coordinateKey: coords.value,
                  visitKey: dates.value,
                },
              },
            ]);
            dialog.close();
            dialog.remove();
            dialog = null;
            refresh(true);
          },
        },
        "Save settings",
      ),
      el(
        "button",
        {
          onclick: () => {
            dialog.close();
            dialog.remove();
            dialog = null;
          },
        },
        "Cancel",
      ),
    );
    dialog.addEventListener("cancel", () => {
      dialog.remove();
      dialog = null;
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  async function open() {
    active = true;
    if (!map && !opening) {
      opening = true;
      try {
        if (!window.L)
          await new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "./vendor/leaflet/leaflet.js";
            script.onload = resolve;
            script.onerror = () => reject(Error("Map library unavailable"));
            document.head.append(script);
          });
        libraryError = "";
        map = L.map(canvas, { center: [9.6, 123.85], zoom: 11, maxZoom: 19 });
        layer = L.layerGroup().addTo(map);
        tile = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
          maxZoom: 19,
          updateWhenIdle: true,
          keepBuffer: 1,
        }).addTo(map);
        tile.on("loading", () => {
          tileFailed = false;
        });
        tile.on("load", () => refresh(true));
        tile.on("tileerror", () => {
          tileFailed = true;
          refresh(true);
        });
        map.on("zoomend", () => renderPins(matching()));
      } catch (error) {
        libraryError = `${error.message}. Saved Records are unchanged; reconnect and reopen Map.`;
        info.textContent = libraryError;
      } finally {
        opening = false;
      }
    }
    map?.invalidateSize();
    refresh(true);
  }
  store.subscribe(() => refresh());
  setInterval(() => refresh(), 60000);
  return {
    open,
    close() {
      active = false;
    },
    refresh: () => refresh(),
    settings,
  };
};
