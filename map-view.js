window.createMayaMap = function ({
  host,
  store,
  getState,
  preferences,
  openRecord,
  visitedToday,
  moveRecord,
}) {
  const M = window.MayaMapModel;
  const groupingKey = "maya-map-group-markers";
  let groupMarkers = true;
  try {
    groupMarkers = localStorage.getItem(groupingKey) !== "off";
  } catch {
    // Browser storage can be unavailable.
  }
  let map,
    layer,
    tile,
    previewLayer,
    gpsLayer,
    opening = false,
    active = false,
    query = "",
    filter = "all",
    fileId = "",
    fit = false,
    tileFailed = false,
    libraryError = "",
    dialog,
    lastSignature = "",
    pinsDirty = true,
    move = null,
    saving = false;
  let watchId = null,
    geoToken = 0,
    locationLive = false,
    firstFix = true,
    fixExpiry,
    cameraZooming = false,
    pendingFix = null,
    lastFix = null;
  const aftersalesColors = { None: "#2563eb", Resolved: "#16a34a", Unresolved: "#dc2626" };
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
    });
  const actionMessage = el("p", {
    role: "status",
    class: "map-action-message",
  });
  const saveStatus = el("p", { role: "status", class: "map-save-status" });
  const gpsStatus = el("p", { role: "status", class: "map-gps-status" });
  const availability = el("p", { role: "status", class: "map-availability" });
  const fitButton = el(
    "button",
    { onclick: () => map && fitAll() },
    "Fit locations",
  );
  const settingsButton = el(
    "button",
    {
      onclick: () => {
        menuOpen(false);
        settingsDialog();
      },
    },
    "Map settings",
  );
  const correctionButton = el(
    "button",
    {
      onclick: () => {
        menuOpen(false);
        correctionsDialog();
      },
    },
    "Needs correction",
  );
  const gpsButton = el(
    "button",
    {
      "aria-pressed": "false",
      onclick: () => {
        menuOpen(false);
        locationLive ? stopLocation("My location off") : startLocation();
      },
    },
    "My location",
  );
  const recenter = el("button", {
    type: "button",
    title: "Recenter on my location",
    "aria-label": "Recenter on my location",
    disabled: true,
    onclick: () => {
      if (lastFix && !move) centerLocation(lastFix);
    },
  }, "◎");
  const source = el("select", {
    "aria-label": "Map source",
    onchange: () => chooseSource(source.value),
  });
  const menuToggle = el(
    "button",
    {
      class: "map-menu-toggle",
      "aria-label": "Map menu",
      "aria-expanded": "false",
      "aria-controls": "map-menu-items",
      onclick: () =>
        menuOpen(menuToggle.getAttribute("aria-expanded") !== "true"),
    },
    "☰",
  );
  const menuItems = el(
    "div",
    { class: "map-menu-items", id: "map-menu-items" },
    source,
    select,
    fitButton,
    settingsButton,
    correctionButton,
    gpsButton,
  );
  const menu = el("div", { class: "map-menu" }, menuToggle, menuItems);
  const movePanel = el("div", { class: "map-move-panel", hidden: true });
  host.append(
    el(
      "section",
      { class: "map-panel" },
      el("h2", {}, "Saved Records Map"),
      el("div", { class: "map-toolbar" }, search, menu),
      legend,
      info,
      canvas,
      el(
        "div",
        { class: "map-status-overlay" },
        saveStatus,
        gpsStatus,
        availability,
        actionMessage,
      ),
      movePanel,
    ),
  );
  function menuOpen(open) {
    menuToggle.setAttribute("aria-expanded", String(open));
    menuItems.classList.toggle("is-open", open);
  }
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target)) menuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menuOpen(false);
  });
  function settings() {
    return store.state().mapSettings;
  }
  function aftersalesFiles() {
    return store.state().datasets.filter((file) => file.kind === "aftersales");
  }
  function chooseSource(id) {
    fileId = id;
    select.disabled = !!move || !!fileId;
    correctionButton.hidden = !!fileId;
    fit = false;
    map?.closePopup();
    refresh(true);
  }
  function matching() {
    const s = getState();
    const ds = fileId && aftersalesFiles().find((file) => file.id === fileId);
    let points;
    if (ds) {
      const coordinate = M.bindings(s.customFields, settings()).coordinate;
      const match = MayaWorkspaceTools.matchAftersales(ds, s, preferences.get());
      points = ds.records.map((row) => {
        const linked = match(row);
        const position = M.coordinates(linked?.details?.[coordinate?.key]);
        const status = MayaAftersales.normalizeStatus(row.status);
        const name = linked?.name || row.details?.["Merchant Name"] || "Aftersales row";
        return {
          record: { id: row.id, name, details: row.details },
          position, color: aftersalesColors[status],
          label: status === "None" ? "Unmarked" : status,
          aftersales: true, unmatched: !linked, coordinateError: !!linked && !position,
        };
      });
    } else {
      points = M.points(s.establishments, s.customFields, settings());
    }
    return points.filter(
      (p) =>
        (!query ||
          [p.record.name, ...Object.values(p.record.details || {})].some((v) =>
            String(v ?? "")
              .toLowerCase()
              .includes(query.toLowerCase()),
          )) &&
        (ds || filter === "all" ||
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
        { padding: [40, 90], maxZoom: 15, animate: false },
      );
      fit = true;
    }
  }
  function actions(point) {
    return el(
      "div",
      { class: "workspace-actions" },
      point.aftersales ? null : el(
        "button",
        { disabled: !!move, onclick: () => openRecord(point.record.id) },
        "Open record",
      ),
      point.aftersales ? null : el(
        "button",
        {
          disabled: !!move || point.age === 0,
          onclick: () => {
            try {
              visitedToday(point.record.id);
              refresh(true);
            } catch (error) {
              actionMessage.textContent = error.message;
            }
          },
        },
        point.age === 0 ? "Visited today ✓" : "Visited today",
      ),
      point.position && !point.aftersales
        ? el(
            "button",
            { disabled: !!move, onclick: () => startMove(point.record.id) },
            "Move location",
          )
        : null,
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
  function renderPin(point) {
    L.circleMarker(point.position, {
      radius: 9,
      color: "#fff",
      weight: 2,
      fillColor: point.color,
      fillOpacity: 1,
      interactive: !move,
    })
      .addTo(layer)
      .bindPopup(() => popup(point));
  }
  function renderPins(points) {
    if (!map) return;
    layer.clearLayers();
    const groups = new Map();
    for (const p of points.filter(
      (p) => p.position && p.record.id !== move?.id,
    )) {
      if (!groupMarkers) {
        renderPin(p);
        continue;
      }
      const pixel = map.project(p.position, map.getZoom()),
        key =
          map.getZoom() >= 17
            ? p.position.join(",")
            : `${Math.floor(pixel.x / 56)},${Math.floor(pixel.y / 56)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      if (group.length === 1) {
        renderPin(group[0]);
        continue;
      }
      const pos = [
        group.reduce((n, p) => n + p.position[0], 0) / group.length,
        group.reduce((n, p) => n + p.position[1], 0) / group.length,
      ];
      const groupStyle = group[0].aftersales
        ? " map-aftersales-" + (group.every((p) => p.label === group[0].label)
          ? group[0].label.toLowerCase() : "mixed")
        : "";
      const marker = L.marker(pos, {
        interactive: !move,
        title: `${group.length} locations`,
        icon: L.divIcon({
          className: "map-cluster" + groupStyle,
          html: String(group.length),
          iconSize: [36, 36],
        }),
      }).addTo(layer);
      marker.on("click", () => {
        const bounds = L.latLngBounds(group.map((p) => p.position));
        if (map.getZoom() >= 17)
          marker
            .bindPopup(
              el(
                "div",
                { class: "map-overlap-list" },
                group.map((p) => popup(p)),
              ),
            )
            .openPopup();
        else if (bounds.getNorthEast().equals(bounds.getSouthWest()))
          map.setView(pos, Math.min(18, map.getZoom() + 2));
        else map.fitBounds(bounds, { padding: [35, 90], maxZoom: 18 });
      });
    }
  }
  function lockMoveControls(locked) {
    for (const n of [
      search,
      source,
      fitButton,
      settingsButton,
      correctionButton,
      gpsButton,
    ])
      n.disabled = locked;
    select.disabled = locked || !!fileId;
    recenter.disabled = locked || !lastFix;
  }
  function updatePreview() {
    if (!move) return;
    const raw = move.marker.getLatLng();
    const p = raw.lng >= -180 && raw.lng <= 180 ? raw : map.wrapLatLng(raw);
    move.coordinates =
      p.lat === move.original[0] && p.lng === move.original[1]
        ? String(move.expectedValue)
        : M.formatCoordinates(p.lat, p.lng);
    move.output.textContent =
      move.coordinates || "Invalid position — drag back onto the map";
    move.save.disabled = saving || !move.coordinates;
  }
  function startMove(id) {
    if (move || !map) return;
    const state = getState(),
      keys = M.bindings(state.customFields, settings()),
      record = state.establishments.find((r) => r.id === id);
    const position = M.coordinates(record?.details?.[keys.coordinate?.key]);
    if (!record || !position || keys.coordinate?.type !== "text") {
      actionMessage.textContent =
        "Choose a text coordinate field with valid latitude, longitude in Map settings.";
      return;
    }
    menuOpen(false);
    map.closePopup();
    actionMessage.textContent = "";
    const output = el("output", { "aria-label": "New coordinates" });
    const save = el(
      "button",
      { class: "primary", onclick: saveMove },
      "Save location",
    );
    const cancel = el("button", { onclick: () => cancelMove() }, "Cancel move");
    const marker = L.marker(position, {
      draggable: true,
      autoPan: true,
      title: "Drag merchant location, or use arrow keys",
      icon: L.divIcon({
        className: "map-move-marker",
        html: "<span></span>",
        iconSize: [32, 40],
        iconAnchor: [16, 36],
      }),
    }).addTo(previewLayer);
    move = {
      id,
      fieldKey: keys.coordinate.key,
      expectedValue: record.details[keys.coordinate.key],
      original: position,
      marker,
      output,
      save,
      cancel,
      coordinates: null,
    };
    movePanel.replaceChildren(
      el("strong", {}, record.name),
      el("p", {}, "Drag the pin. Only Save changes the recorded coordinates."),
      el("small", {}, "Original: " + String(move.expectedValue)),
      output,
      el("div", { class: "workspace-actions" }, save, cancel),
    );
    movePanel.hidden = false;
    lockMoveControls(true);
    renderPins(matching());
    marker.on("drag", updatePreview);
    marker.on("dragend", updatePreview);
    marker
      .getElement()
      .setAttribute(
        "aria-label",
        "Move " + record.name + " — drag or use arrow keys",
      );
    marker.getElement().addEventListener("keydown", (event) => {
      const deltas = {
          ArrowLeft: [-8, 0],
          ArrowRight: [8, 0],
          ArrowUp: [0, -8],
          ArrowDown: [0, 8],
        },
        d = deltas[event.key];
      if (!d || saving) return;
      event.preventDefault();
      event.stopPropagation();
      const p = map.latLngToContainerPoint(marker.getLatLng());
      marker.setLatLng(map.containerPointToLatLng([p.x + d[0], p.y + d[1]]));
      updatePreview();
    });
    map.setView(position, Math.max(17, map.getZoom()), { animate: false });
    updatePreview();
  }
  function cancelMove() {
    if (saving) return false;
    if (!move) return true;
    previewLayer.clearLayers();
    move = null;
    pinsDirty = true;
    movePanel.hidden = true;
    lockMoveControls(false);
    refresh(true);
    return true;
  }
  async function saveMove() {
    if (!move || saving || !move.coordinates) return;
    const attempt = move;
    saving = true;
    attempt.marker.dragging.disable();
    attempt.save.disabled = true;
    attempt.cancel.disabled = true;
    actionMessage.textContent = "Saving merchant coordinates…";
    try {
      const durable = await moveRecord({
        id: attempt.id,
        fieldKey: attempt.fieldKey,
        expectedValue: attempt.expectedValue,
        coordinates: attempt.coordinates,
      });
      previewLayer.clearLayers();
      move = null;
      movePanel.hidden = true;
      lockMoveControls(false);
      actionMessage.textContent =
        durable === false
          ? "Device storage failed. Keep this app open and download a Saved Records backup under Records → Options."
          : "Merchant coordinates saved on this device. Check the sync indicator for cloud saving.";
    } catch (error) {
      actionMessage.textContent = error.message;
      attempt.marker.dragging.enable();
    } finally {
      saving = false;
      pinsDirty = true;
      if (move) {
        move.save.disabled = false;
        move.cancel.disabled = false;
      }
      refresh(true);
    }
  }
  function correctionsDialog() {
    const input = el("input", {
        type: "search",
        "aria-label": "Search coordinate corrections",
        placeholder: "Search records needing correction…",
      }),
      body = el("div", { class: "map-corrections-list" });
    const close = () => {
      dialog.close();
      dialog.remove();
      dialog = null;
    };
    function draw() {
      const state = getState(),
        q = input.value.toLowerCase();
      const points = M.points(
        state.establishments,
        state.customFields,
        settings(),
      ).filter(
        (p) =>
          (p.coordinateError || ["invalid", "future"].includes(p.category)) &&
          (!q ||
            [p.record.name, ...Object.values(p.record.details || {})].some(
              (v) =>
                String(v ?? "")
                  .toLowerCase()
                  .includes(q),
            )),
      );
      body.replaceChildren(
        ...points.slice(0, 200).map((p) =>
          el(
            "article",
            { class: "map-correction" },
            el("strong", {}, p.record.name),
            el(
              "small",
              {},
              p.coordinateError ? "Missing/invalid coordinates" : p.label,
            ),
            el(
              "button",
              {
                onclick: () => {
                  close();
                  openRecord(p.record.id);
                },
              },
              "Open record",
            ),
          ),
        ),
      );
      if (!points.length)
        body.append(el("p", {}, "No records need correction."));
      if (points.length > 200)
        body.append(
          el(
            "p",
            {},
            `Showing 200 of ${points.length}. Search to narrow the list.`,
          ),
        );
    }
    input.addEventListener("input", draw);
    dialog = el(
      "dialog",
      { class: "workspace-dialog", "aria-label": "Needs correction" },
      el("h3", {}, "Needs correction"),
      input,
      body,
      el("button", { onclick: close }, "Close"),
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    document.body.append(dialog);
    dialog.showModal();
    draw();
  }
  function stopLocation(message = "", pause = false) {
    clearTimeout(fixExpiry);
    geoToken++;
    if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    watchId = null;
    if (!pause) locationLive = false;
    clearLocationFix(message);
    gpsButton.textContent = locationLive ? "Turn off my location" : "My location";
    gpsButton.setAttribute("aria-pressed", String(locationLive));
  }
  function clearLocationFix(message) {
    pendingFix = lastFix = null;
    recenter.disabled = true;
    gpsLayer?.clearLayers();
    gpsStatus.textContent = message;
  }
  function centerLocation({ lat, lng }) {
    fit = true;
    map.setView([lat, lng], Math.max(map.getZoom(), 16), { animate: false });
  }
  function drawCurrentLocation() {
    if (!pendingFix || !active || !locationLive || document.hidden) return;
    if (firstFix && active && cameraZooming) {
      gpsStatus.textContent = "GPS found. Finishing map zoom…";
      return;
    }
    const { lat, lng, accuracy, token, timestamp } = pendingFix;
    pendingFix = null;
    if (token !== geoToken) return;
    if (Date.now() - timestamp > 30000) {
      clearLocationFix("GPS reading expired. Waiting for a fresh reading…");
      return;
    }
    if (firstFix && !move) {
      firstFix = false;
      centerLocation({ lat, lng });
    }
    lastFix = { lat, lng };
    recenter.disabled = !!move;
    gpsLayer.clearLayers();
    L.circle([lat, lng], {
      radius: accuracy,
      color: "#2563eb",
      weight: 1,
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(gpsLayer);
    L.circleMarker([lat, lng], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: "#2563eb",
      fillOpacity: 1,
      interactive: false,
      className: "map-my-location-dot",
    }).addTo(gpsLayer);
    gpsStatus.textContent = `You are here · accuracy about ${Math.round(accuracy)} m`;
  }
  function startLocation(resume = false) {
    if (!map || document.hidden || watchId !== null) return;
    if (!window.isSecureContext || !navigator.geolocation) {
      gpsStatus.textContent = "Location needs a current browser over HTTPS.";
      return;
    }
    stopLocation("", resume);
    locationLive = true;
    if (!resume) firstFix = true;
    gpsButton.textContent = "Turn off my location";
    gpsButton.setAttribute("aria-pressed", "true");
    gpsStatus.textContent = "Finding your current location…";
    const token = geoToken;
    try {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (token !== geoToken || document.hidden) return;
          const { latitude: lat, longitude: lng, accuracy } = position.coords;
          if (
            !M.formatCoordinates(lat, lng) ||
            !Number.isFinite(accuracy) ||
            accuracy < 0 ||
            Date.now() - position.timestamp > 30000
          ) {
            clearTimeout(fixExpiry);
            clearLocationFix("Waiting for a fresh, valid GPS reading…");
            return;
          }
          clearTimeout(fixExpiry);
          fixExpiry = setTimeout(
            () =>
              clearLocationFix("GPS reading expired. Waiting for a fresh reading…"),
            Math.max(0, 30000 - (Date.now() - position.timestamp)),
          );
          pendingFix = {
            lat,
            lng,
            accuracy,
            token,
            timestamp: position.timestamp,
          };
          drawCurrentLocation();
        },
        (error) => {
          if (token !== geoToken) return;
          stopLocation(
            error.code === 1
              ? "Location permission denied. Enable it in your browser if you want to see your position."
              : error.code === 3
                ? "Location timed out. Tap My location to try again."
                : "Location is unavailable. Tap My location to try again.",
          );
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
    } catch {
      stopLocation(
        "Location is unavailable. Check browser permissions and try again.",
      );
    }
  }
  function syncStatus() {
    const status = document.getElementById("sync-status"),
      notice = document.getElementById("sync-notice");
    const text = status?.textContent || "Opening device storage…";
    saveStatus.textContent =
      notice && !notice.hidden
        ? "Review preserved copy in Records → Options"
        : text;
    saveStatus.title = notice && !notice.hidden ? notice.textContent : text;
    saveStatus.dataset.state = status?.dataset.state || "";
  }
  const statusSource = document.querySelector(".sync-panel");
  if (statusSource)
    new MutationObserver(syncStatus).observe(statusSource, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "data-state"],
    });
  syncStatus();
  document.addEventListener("visibilitychange", () => {
    if (!locationLive) return;
    if (document.hidden) stopLocation("Location paused while Procast is hidden.", true);
    else startLocation(true);
  });
  window.addEventListener("pagehide", (event) => stopLocation("", event.persisted));
  window.addEventListener("pageshow", () => {
    if (locationLive) startLocation(true);
  });
  function refresh(force = false) {
    if (!active) return;
    const files = aftersalesFiles();
    const file = files.find((item) => item.id === fileId);
    if (fileId && !file) {
      fileId = "";
      select.disabled = !!move;
      correctionButton.hidden = false;
      fit = false;
    }
    const choices = JSON.stringify(files.map(({ id, name }) => [id, name]));
    if (source.dataset.choices !== choices) {
      source.replaceChildren(
        el("option", { value: "" }, "Saved Records"),
        ...files.map(({ id, name }) => el("option", { value: id }, "Aftersales: " + name)),
      );
      source.dataset.choices = choices;
    }
    source.value = fileId;
    const data = getState(),
      s = settings(),
      key = JSON.stringify([
        data.establishments,
        data.customFields,
        s,
        query,
        filter,
        fileId,
        file?.records,
        file?.headers,
        file?.generation,
        file ? preferences.get().links : null,
        file ? preferences.get().pairs : null,
        M.today(),
      ]);
    const changed = key !== lastSignature;
    if (!force && !changed && !pinsDirty) return;
    lastSignature = key;
    const keys = M.bindings(data.customFields, s),
      points = matching(),
      bad = points.filter((p) => p.coordinateError).length;
    const categories = file
      ? [["None", "Unmarked"], ["Resolved", "Resolved"], ["Unresolved", "Unresolved"]]
      : [
          ["recent", `0–${s.greenDays} days`],
          ["due", `${s.greenDays + 1}–${s.orangeDays} days`],
          ["overdue", `Over ${s.orangeDays} days`],
          ["unvisited", "No visit date"],
          ["invalid", "Check date / coordinates"],
        ];
    const colors = file ? aftersalesColors : M.COLORS;
    legend.replaceChildren(
      ...categories.map(([category, text]) =>
        el("span", {}, el("i", { style: `background:${colors[category]}` }), text),
      ),
    );
    const bindingError = !keys.coordinate || (!file && !keys.visit);
    const missingFields = file
      ? "Choose a coordinate field in Map settings to see linked Aftersales pins."
      : "Choose the coordinate and LAST VISIT fields in Map settings.";
    const mapped = points.filter((p) => p.position).length;
    info.textContent = libraryError
      ? libraryError
      : bindingError
        ? missingFields
        : tileFailed
          ? "Map background unavailable. Pins still work."
          : file
            ? `${mapped} mapped · ${points.filter((p) => p.unmatched).length} need matching · ${bad} missing coordinates`
            : `${mapped} mapped · ${bad} missing/invalid coordinates. Visit ranges use Philippine dates. Map backgrounds need internet.`;
    availability.textContent =
      libraryError ||
      (bindingError
        ? missingFields
        : tileFailed
          ? "Map background unavailable. Pins still work."
          : "");
    if (map && (changed || pinsDirty)) {
      renderPins(points);
      pinsDirty = false;
    }
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
    const groupingMessage = el("p", { role: "status" });
    const groupingToggle = el("input", {
      type: "checkbox",
      checked: groupMarkers,
      onchange: (event) => {
        groupMarkers = event.target.checked;
        groupingMessage.textContent = "";
        try {
          localStorage.setItem(groupingKey, groupMarkers ? "on" : "off");
        } catch {
          groupingMessage.textContent =
            "Grouping changed for this session. Browser storage is unavailable.";
        }
        pinsDirty = true;
        refresh();
      },
    });
    dialog = el(
      "dialog",
      { class: "workspace-dialog", "aria-label": "Map settings" },
      el("h3", {}, "Map settings"),
      el("label", { class: "workspace-check" }, groupingToggle, "Group map markers (this browser)"),
      groupingMessage,
      el("h4", {}, "Shared across devices"),
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
        const locationControl = L.control({ position: "bottomright" });
        locationControl.onAdd = () => {
          const container = el("div", { class: "leaflet-bar map-recenter" }, recenter);
          L.DomEvent.disableClickPropagation(container);
          return container;
        };
        locationControl.addTo(map);
        layer = L.layerGroup().addTo(map);
        previewLayer = L.layerGroup().addTo(map);
        gpsLayer = L.layerGroup().addTo(map);
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
        map.on("zoomstart", () => {
          cameraZooming = true;
        });
        map.on("zoomend", () => {
          cameraZooming = false;
          renderPins(matching());
          drawCurrentLocation();
        });
      } catch (error) {
        libraryError = `${error.message}. Saved Records are unchanged; reconnect and reopen Map.`;
        info.textContent = libraryError;
      } finally {
        opening = false;
      }
    }
    map?.invalidateSize();
    refresh(true);
    drawCurrentLocation();
  }
  store.subscribe(() => refresh());
  setInterval(() => refresh(), 60000);
  return {
    open,
    close() {
      active = false;
      menuOpen(false);
    },
    canClose() {
      if (saving) return false;
      if (
        move &&
        !confirm(
          "Discard this unsaved pin move? Recorded coordinates will stay unchanged.",
        )
      )
        return false;
      return cancelMove();
    },
    hasDraft: () => !!move || saving,
    resize() {
      requestAnimationFrame(() => map?.invalidateSize());
    },
    refresh: () => refresh(),
    settings,
  };
};
