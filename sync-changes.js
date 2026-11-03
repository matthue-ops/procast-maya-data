/* Pure change descriptions: shared by the browser and regression tests. */
(function (root) {
    const copy = value => structuredClone(value);
    const dataOnly = value => ({
        customFields: value.customFields || [],
        establishments: (value.establishments || []).map(({ collapsed, ...record }) => record),
        savedFilters: value.savedFilters || [],
        aftersalesHeaders: value.aftersalesHeaders || [],
        aftersalesRecords: value.aftersalesRecords || []
    });
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function changesBetween(before, after, intent) {
        const previous = dataOnly(before), next = dataOnly(after);
        if (intent?.kind === 'replace_all') return [{ kind: 'replace_all', expected: previous, value: next }];
        if (intent?.kind === 'replace_aftersales') return [{ kind: 'replace_aftersales',
            expected: { aftersalesHeaders: previous.aftersalesHeaders, aftersalesRecords: previous.aftersalesRecords },
            value: { aftersalesHeaders: next.aftersalesHeaders, aftersalesRecords: next.aftersalesRecords } }];
        const changes = [];
        const schemaAction = ['rename_field', 'delete_field'].includes(intent?.kind);
        if (schemaAction) changes.push(copy(intent));
        else {
            const oldFields = new Map(previous.customFields.map(field => [field.key, field]));
            const newFields = new Map(next.customFields.map(field => [field.key, field]));
            for (const [key] of oldFields) if (!newFields.has(key)) changes.push({ kind: 'delete_field', key });
            for (const [key, field] of newFields) {
                if (!oldFields.has(key)) changes.push({ kind: 'add_field', field });
                else if (!equal(oldFields.get(key), field)) changes.push({ kind: 'set_field', field });
            }
            if (!equal(previous.customFields.map(f => f.key), next.customFields.map(f => f.key)))
                changes.push({ kind: 'order_fields', keys: next.customFields.map(f => f.key) });
        }
        for (const collection of ['establishments', 'aftersalesRecords', 'savedFilters']) {
            const oldRows = new Map(previous[collection].map(row => [String(row.id), row]));
            const newRows = new Map(next[collection].map(row => [String(row.id), row]));
            for (const [id] of oldRows) if (!newRows.has(id)) changes.push({ kind: 'delete', collection, id });
            for (const [id, row] of newRows) {
                const old = oldRows.get(id);
                if (!old) { changes.push({ kind: 'create', collection, id, value: copy(row) }); continue; }
                const set = {}, unset = [], details_set = {}, details_unset = [];
                for (const key of new Set([...Object.keys(old), ...Object.keys(row)])) {
                    if (['id', 'collapsed', 'details'].includes(key)) continue;
                    if (!(key in row)) unset.push(key);
                    else if (!equal(old[key], row[key])) Object.defineProperty(set, key, { value: copy(row[key]), enumerable: true });
                }
                if (!schemaAction || collection !== 'establishments') {
                    const a = old.details || {}, b = row.details || {};
                    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
                        if (!(key in b)) details_unset.push(key);
                        else if (!equal(a[key], b[key])) Object.defineProperty(details_set, key, { value: copy(b[key]), enumerable: true });
                    }
                }
                if (Object.keys(set).length || unset.length || Object.keys(details_set).length || details_unset.length)
                    changes.push({ kind: 'update', collection, id, set, unset, details_set, details_unset });
            }
        }
        const extraHeaders = next.aftersalesHeaders.filter(header => !previous.aftersalesHeaders.includes(header));
        if (extraHeaders.length) changes.unshift({ kind: 'merge_headers', value: extraHeaders });
        return changes;
    }
    const api = { dataOnly, changesBetween };
    root.MayaChanges = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
