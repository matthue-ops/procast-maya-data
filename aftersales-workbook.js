/* Aftersales Excel interchange. Metadata is not a visible business column. */
(function (root) {
    const MARKER = '__PROJECT_MAYA_MARKER_V1__';
    const FALLBACK = 'AFTERSALES_RECHECKING_HIGHLIGHTED.xlsx';
    function normalizeStatus(value) {
        const status = String(value ?? '').trim().toLowerCase();
        return status === 'resolved' ? 'Resolved' : status === 'unresolved' ? 'Unresolved' : 'None';
    }
    function filename(value) {
        const base = String(value || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
        return base ? (/\.(xlsx|xls)$/i.test(base) ? base.replace(/\.(xlsx|xls)$/i, '.xlsx') : `${base}.xlsx`) : FALLBACK;
    }
    function exportFilename(records) {
        const names = new Set(records.map(r => r._sourceFileName).filter(name => typeof name === 'string' && name.trim()));
        return names.size === 1 ? filename([...names][0]) : FALLBACK;
    }
    function filtered(records, query, status) {
        const search = String(query || '').trim().toLowerCase();
        return records.filter(record => normalizeStatus(record.status) === status && (!search ||
            [record.merchantName, record.dbaName, ...Object.values(record.details || {}), record.status]
                .some(value => String(value ?? '').toLowerCase().includes(search))));
    }
    function parseSheet(XLSX, worksheet, options = {}) {
        const markerHeader = options.markerHeader || MARKER, normalize = options.normalizeStatus || normalizeStatus;
        const values = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', blankrows: false, skipHidden: false });
        if (!values.length) throw new Error('Excel file is empty.');
        const columns = [], seen = new Set();
        let markerIndex = -1, fieldsIndex = -1;
        values[0].forEach((value, index) => {
            const name = String(value ?? '').trim();
            if (!name) return;
            if (options.preserveFields && name === '__PROJECT_MAYA_FIELDS_V1__') {
                if (fieldsIndex !== -1) throw new Error('Duplicate hidden field metadata.');
                fieldsIndex = index; return;
            }
            if (options.preserveFields && ['__PROJECT_MAYA_MARKER_V1__', '__PROJECT_MAYA_VISIT_V1__'].includes(name) && name !== markerHeader) throw new Error('This file has markers for the other tab. Upload it in the matching tab.');
            if (name === markerHeader) {
                if (markerIndex !== -1) throw new Error('Duplicate hidden marker columns.');
                markerIndex = index; return;
            }
            if (seen.has(name)) throw new Error(`Duplicate column name: ${name}. Rename it before uploading.`);
            seen.add(name); columns.push({ name, index });
        });
        if (!columns.length) throw new Error('No visible data headers found.');
        const rows = values.slice(1).filter(row => columns.some(column => String(row[column.index] ?? '').trim() !== '')).map(row => {
            const details = Object.fromEntries(columns.map(column => [column.name,
                row[column.index] === '' || row[column.index] == null ? (options.blankValue ?? '—') : String(row[column.index])]));
            if (fieldsIndex >= 0 && row[fieldsIndex]) {
                let keys; try { keys = JSON.parse(String(row[fieldsIndex])); } catch { throw new Error('Invalid hidden field metadata.'); }
                if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !columns.some(c => c.name === key))) throw new Error('Invalid hidden field metadata.');
                for (const key of Object.keys(details)) if (!keys.includes(key)) delete details[key];
            }
            return { details, status: markerIndex < 0 ? 'None' : normalize(row[markerIndex]) };
        });
        return { headers: columns.map(column => column.name), rows };
    }
    function makeWorkbook(XLSX, headers, records, options = {}) {
        const markerHeader = options.markerHeader || MARKER, normalize = options.normalizeStatus || normalizeStatus;
        const visible = headers.filter(header => header !== markerHeader);
        if (!visible.length || !records.length) throw new Error('No aftersales records to export.');
        const rows = [[...visible, markerHeader, ...(options.preserveFields ? ['__PROJECT_MAYA_FIELDS_V1__'] : [])], ...records.map(record => [
            ...visible.map(header => record.details?.[header] ?? '—'), normalize(record.status), ...(options.preserveFields ? [JSON.stringify(Object.keys(record.details || {}))] : [])
        ])];
        const worksheet = XLSX.utils.aoa_to_sheet(rows);
        worksheet['!cols'] = visible.map(() => ({}));
        worksheet['!cols'].push({ hidden: true });
        if (options.preserveFields) worksheet['!cols'].push({ hidden: true });
        records.forEach((record, index) => {
            const status = normalizeStatus(record.status);
            const color = status === 'Resolved' ? 'D1FAE5' : status === 'Unresolved' ? 'FEE2E2' : null;
            visible.forEach((header, column) => {
                const ref = XLSX.utils.encode_cell({ r: index + 1, c: column });
                worksheet[ref] ||= { t: 's', v: '' };
                worksheet[ref].s = { font: { name: 'Calibri', sz: 11 },
                    ...(color ? { fill: { patternType: 'solid', fgColor: { rgb: color } } } : {}) };
            });
        });
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Aftersales Rechecking');
        return workbook;
    }
    const api = { MARKER, FALLBACK, normalizeStatus, filename, exportFilename, filtered, parseSheet, makeWorkbook };
    root.MayaAftersales = api;
    if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
