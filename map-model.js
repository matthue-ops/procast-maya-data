(function (root) {
  const COLORS = {
    recent: "#16a34a",
    due: "#f59e0b",
    overdue: "#dc2626",
    unvisited: "#64748b",
    invalid: "#7c3aed",
    future: "#7c3aed",
  };
  function coordinates(value) {
    const match = String(value ?? "")
      .trim()
      .replace(/^\((.*)\)$/, "$1")
      .match(/^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const lat = Number(match[1]),
      lng = Number(match[2]);
    return Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
      ? [lat, lng]
      : null;
  }
  function today(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (k) => parts.find((p) => p.type === k).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }
  function day(value) {
    const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]),
      month = Number(m[2]),
      d = Number(m[3]);
    if (y < 1900 || y > 9999) return null;
    const date = new Date(Date.UTC(y, month - 1, d));
    return date.getUTCFullYear() === y &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === d
      ? date.getTime() / 86400000
      : null;
  }
  function visit(value, settings, now = new Date()) {
    if (value == null || String(value).trim() === "" || value === "—")
      return {
        category: "unvisited",
        label: "No visit date",
        color: COLORS.unvisited,
        age: null,
      };
    const date = day(value);
    if (date == null)
      return {
        category: "invalid",
        label: "Invalid visit date",
        color: COLORS.invalid,
        age: null,
      };
    const age = day(today(now)) - date;
    const category =
      age < 0
        ? "future"
        : age <= settings.greenDays
          ? "recent"
          : age <= settings.orangeDays
            ? "due"
            : "overdue";
    return {
      category,
      age,
      color: COLORS[category],
      label:
        age < 0
          ? "Future visit date"
          : `${age} day${age === 1 ? "" : "s"} since visit`,
    };
  }
  const normalized = (s) =>
    String(s)
      .split(":")
      .at(-1)
      .replace(/[\s_-]/g, "")
      .toUpperCase();
  function bindings(fields, settings) {
    const find = (key, aliases, defaultKey) =>
      fields.find((f) => f.key === key) ||
      (key === defaultKey &&
      fields.filter((f) => aliases.includes(normalized(f.key))).length === 1
        ? fields.find((f) => aliases.includes(normalized(f.key)))
        : null);
    return {
      coordinate: find(
        settings.coordinateKey,
        ["COORDINATE", "COORDINATES"],
        "COORDINATES",
      ),
      visit: find(settings.visitKey, ["LASTVISIT"], "LAST VISIT"),
    };
  }
  function points(records, fields, settings, now) {
    const keys = bindings(fields, settings);
    return records.map((record) => {
      const position = coordinates(record.details?.[keys.coordinate?.key]);
      return {
        record,
        position,
        ...visit(record.details?.[keys.visit?.key], settings, now),
        coordinateError: !position,
      };
    });
  }
  function formatCoordinates(lat, lng) {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      return null;
    return [lat, lng].map((v) => String(Number(v.toFixed(7)))).join(", ");
  }
  const api = {
    formatCoordinates,
    COLORS,
    coordinates,
    today,
    day,
    visit,
    bindings,
    points,
  };
  root.MayaMapModel = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window === "undefined" ? globalThis : window);
