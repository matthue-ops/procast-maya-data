/* Durable local saves and revision-checked cloud synchronization. */
window.createMayaSync = async function ({ client, getState, applyState, canRefresh }) {
    const clone = value => structuredClone(value);
    const dataOnly = value => ({
        customFields: value.customFields || [],
        establishments: (value.establishments || []).map(({ collapsed, ...record }) => record),
        savedFilters: value.savedFilters || [],
        aftersalesHeaders: value.aftersalesHeaders || [],
        aftersalesRecords: value.aftersalesRecords || []
    });
    const signature = value => {
        const data = dataOnly(value);
        // The existing renderer sorts establishments in place. Display order is
        // not an edit; compare records by stable ID without changing render code.
        data.establishments.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return JSON.stringify(data);
    };
    const status = document.getElementById('sync-status');
    const localTime = document.getElementById('sync-local-time');
    const cloudTime = document.getElementById('sync-cloud-time');
    const saveButton = document.getElementById('save-device-btn');
    const cloudButton = document.getElementById('use-cloud-btn');
    const replaceButton = document.getElementById('replace-cloud-btn');
    const deviceInput = document.getElementById('device-name-input');
    const deviceFeedback = document.getElementById('device-name-feedback');
    const sourceName = payload => typeof payload?._syncSource?.deviceName === 'string'
        ? payload._syncSource.deviceName.trim().slice(0, 40) || 'Unknown device' : 'Unknown device';
    const downloadButton = document.getElementById('download-local-btn');
    document.getElementById('app').inert = true;
    let db, record, message = '', conflict = false, busy = false, durable = false, adopting = false;
    let chain = Promise.resolve();
    let lastSignature;
    const formatTime = value => value ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium', timeStyle: 'short'
    }).format(new Date(value)) : 'Not available';
    function display() {
        status.textContent = message || (conflict ? 'Newer cloud data available — choose a version below'
            : busy ? 'Syncing…' : record?.dirty ? (navigator.onLine
                ? 'Saved on this device — waiting to sync' : 'Saved on this device — offline')
                : record?.revision != null ? 'Saved to cloud' : 'Cloud version not verified');
        localTime.textContent = `Local edit: ${formatTime(record?.localEditedAt)}`;
        cloudTime.textContent = record?.cloudSavedAt
            ? `Last cloud update: ${formatTime(record.cloudSavedAt)} · ${record.cloudDeviceName || 'Unknown device'}`
            : 'Cloud update: Not available';
        cloudTime.title = `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
        cloudButton.hidden = replaceButton.hidden = !conflict;
        saveButton.disabled = !durable || adopting;
    }
    function transaction(mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('state', mode);
            const store = tx.objectStore('state');
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local storage transaction failed'));
            operation(store, value => { result = value; });
        });
    }
    async function persist(extraBackup) {
        const snapshot = clone(record);
        try {
            await transaction('readwrite', store => {
                if (extraBackup) store.put(clone(extraBackup), `backup-${crypto.randomUUID()}`);
                store.put(snapshot, 'current');
            });
            durable = true;
            return true;
        } catch (error) {
            durable = false;
            message = 'Local save failed — download a backup now. Cloud sync paused.';
            document.getElementById('sync-options').open = true;
            display();
            return false;
        }
    }
    function enqueue(work) {
        const next = chain.then(work);
        chain = next.catch(error => {
            message = `Sync paused: ${error.message}. Your pending copy is retained.`;
            display();
        });
        return chain;
    }
    function download() {
        const blob = new Blob([JSON.stringify({ ...record, state: getState() }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `maya-device-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    downloadButton.addEventListener('click', download);
    document.getElementById('download-history-btn').addEventListener('click', () => enqueue(async () => {
        if (!db) { message = 'Device storage is unavailable'; display(); return; }
        const backups = await transaction('readonly', (store, done) => {
            const entries = [];
            store.openCursor().onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) { done(entries); return; }
                if (String(cursor.key).startsWith('backup-')) entries.push({ key: cursor.key, copy: cursor.value });
                cursor.continue();
            };
        });
        const url = URL.createObjectURL(new Blob([JSON.stringify(backups, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'maya-preserved-device-copies.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    function capture() {
        const snapshot = clone(getState());
        const nextSignature = signature(snapshot);
        if (nextSignature !== lastSignature) {
            record.dirty = true;
            record.localEditedAt = new Date().toISOString();
            lastSignature = nextSignature;
        }
        record.state = snapshot;
    }
    async function readCloud() {
        if (!client) throw new Error('Cloud library unavailable; reconnect and reload after saving locally');
        const { data, error } = await client.rpc('maya_read_state');
        if (error) throw new Error('Cloud read unavailable. Check connection and install the sync SQL');
        if (!data || !/^\d+$/.test(data.revision) || !data.payload || typeof data.payload !== 'object'
            || Array.isArray(data.payload)) throw new Error('Cloud data or revision is invalid');
        return data;
    }
    async function adoptCloud(cloud) {
        if (!canRefresh()) { message = 'Newer cloud data available — finish or close your form, then sync'; return; }
        adopting = true;
        try {
        const previous = clone(record);
        const preferences = record.state;
        record.state = { ...preferences, ...cloud.payload };
        // Keep navigation and device preferences local, including old cloud UI fields.
        for (const key of ['activeTab', 'isDarkMode', 'isListExpanded', 'activeFilterId',
            'aftersalesActiveFilterId', 'searchTerm', 'aftersalesSearchTerm']) {
            if (key in preferences) record.state[key] = preferences[key];
        }
        record.state.editingEstablishmentId = record.state.viewingEstablishmentId = null;
        record.state.editingFilterId = null;
        record.revision = cloud.revision;
        record.cloudSavedAt = cloud.updated_at;
        record.cloudDeviceName = sourceName(cloud.payload);
        record.dirty = false;
        record.pending = null;
        document.getElementById('app').inert = true;
        const stored = await persist(previous.dirty || previous.pending ? previous : null);
        document.getElementById('app').inert = false;
        if (!stored) { record = previous; return; }
        lastSignature = signature(record.state);
        applyState(clone(record.state));
        conflict = false;
        message = '';
        } finally {
            adopting = false;
            document.getElementById('app').inert = false;
        }
    }
    async function sync() {
        if (!durable || conflict || !navigator.onLine) { display(); return; }
        busy = true;
        message = '';
        display();
        try {
            // Never discard an uncertain request: reconcile it before another read/save.
            if (record.pending) {
                if (!client) throw new Error('Cloud library unavailable');
                const pending = clone(record.pending);
                const { data, error } = await client.rpc('maya_save_state', pending);
                if (error) throw new Error('Cloud save not confirmed. Check connection and sync SQL');
                if (!data || data.request_id !== pending.p_request_id
                    || !['saved', 'already_saved', 'conflict'].includes(data.status)
                    || !/^\d+$/.test(data.current_revision)) throw new Error('Invalid save response');
                if (data.status === 'conflict') {
                    conflict = true;
                    record.cloudSavedAt = data.current_updated_at;
                    record.cloudDeviceName = 'Unknown device';
                    await persist();
                    return;
                }
                if (!/^\d+$/.test(data.saved_revision)) throw new Error('Invalid saved revision');
                record.revision = data.saved_revision;
                record.cloudSavedAt = data.saved_at;
                record.cloudDeviceName = sourceName(pending.p_payload);
                record.dirty = signature(record.state) !== signature(pending.p_payload);
                record.pending = null;
                if (!await persist()) return;
                if (data.current_revision !== data.saved_revision) {
                    if (record.dirty) { conflict = true; return; }
                    if (canRefresh()) await adoptCloud(await readCloud());
                    else message = 'Newer cloud data available — finish or close your form, then sync';
                    return;
                }
            }
            const cloud = await readCloud();
            record.cloudDeviceName = sourceName(cloud.payload);
            record.cloudSavedAt = cloud.updated_at;
            if (!record.dirty) {
                if (record.revision !== cloud.revision) {
                    if (canRefresh()) await adoptCloud(cloud);
                    else message = 'Newer cloud data available — finish or close your form, then sync';
                }
                return;
            }
            if (record.revision === null || record.revision !== cloud.revision) {
                record.cloudSavedAt = cloud.updated_at;
                record.cloudDeviceName = sourceName(cloud.payload);
                conflict = true;
                await persist();
                return;
            }
            record.pending = {
                p_expected_revision: record.revision,
                p_request_id: crypto.randomUUID(),
                p_payload: { ...dataOnly(clone(record.state)),
                    _syncSource: { deviceName: record.deviceName } }
            };
            if (!await persist()) return;
            // Queue another pass, allowing pending edits to be durably captured first.
            enqueue(sync);
        } finally { busy = false; display(); }
    }
    const api = {
        save() {
            if (!record || adopting) return;
            capture();
            return enqueue(async () => {
                if (await persist()) {
                    message = '';
                    display();
                    enqueue(sync);
                }
            });
        },
        refresh() { return enqueue(sync); }
    };
    document.getElementById('save-device-name-btn').addEventListener('click', () => enqueue(async () => {
        if (!record || !durable) return;
        const name = deviceInput.value.trim();
        if (!name || name.length > 40) {
            deviceFeedback.textContent = 'Enter a name between 1 and 40 characters.';
            return;
        }
        const previous = record.deviceName;
        record.deviceName = name;
        if (!await persist()) { record.deviceName = previous; return; }
        deviceInput.value = name;
        deviceFeedback.textContent = 'Device name saved. It will appear on your next data update.';
        // Naming a device does not make the dataset newer or create a cloud write.
        display();
    }));
    saveButton.addEventListener('click', () => api.save());
    document.getElementById('sync-now-btn').addEventListener('click', () => {
        // A retry after a storage failure must re-persist before any cloud operation.
        api.save();
    });
    cloudButton.addEventListener('click', () => enqueue(async () => {
        if (!canRefresh()) { message = 'Finish or close your form before choosing a cloud version'; display(); return; }
        if (!confirm('Use the cloud version? Your local version will be retained as a device backup.')) return;
        await adoptCloud(await readCloud());
        display();
    }));
    replaceButton.addEventListener('click', () => enqueue(async () => {
        const cloud = await readCloud();
        if (!confirm(`Replace cloud data saved ${formatTime(cloud.updated_at)} with this device's committed records? This replaces the whole dataset.`)) return;
        const previous = clone(record);
        record.revision = cloud.revision;
        record.cloudSavedAt = cloud.updated_at;
        record.cloudDeviceName = sourceName(cloud.payload);
        record.pending = null;
        record.dirty = true;
        if (!await persist({ local: previous, cloud })) { record = previous; return; }
        conflict = false;
        message = '';
        enqueue(sync);
    }));
    window.addEventListener('online', () => api.refresh());
    window.addEventListener('offline', display);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') api.refresh();
    });
    window.addEventListener('focus', () => api.refresh());
    window.addEventListener('beforeunload', event => {
        if (record?.dirty || record?.pending || !durable) { event.preventDefault(); event.returnValue = ''; }
    });
    try {
        if (!navigator.locks) throw new Error('Use a current browser over HTTPS for safe device saving');
        // One writer tab per origin. Other tabs cannot overwrite this tab's pending copy.
        let grant;
        const granted = new Promise(resolve => { grant = resolve; });
        navigator.locks.request('maya-sync-writer', { ifAvailable: true }, lock => {
            grant(!!lock);
            return lock ? new Promise(() => {}) : undefined;
        });
        if (!await granted) throw new Error('Another Maya tab is open. Close it, then reload this tab');
        db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('maya-device-sync', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('state');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        record = await transaction('readonly', (store, done) => {
            store.get('current').onsuccess = event => done(event.target.result);
        });
        if (!record) {
            let legacy;
            try { legacy = JSON.parse(localStorage.getItem('enterpriseDataManager') || 'null'); }
            catch { throw new Error('Existing local copy cannot be read; preserve browser storage before continuing'); }
            record = { state: legacy || clone(getState()), revision: null,
                dirty: !!legacy, localEditedAt: null, cloudSavedAt: null, pending: null };
        }
        record.deviceName ||= /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'My Phone' : 'My PC';
        deviceInput.value = record.deviceName;
        lastSignature = signature(record.state);
        if (!await persist()) throw new Error('Cannot initialize durable storage');
        applyState(clone(record.state));
        document.getElementById('app').inert = false;
        api.refresh();
    } catch (error) {
        durable = false;
        message = `${error.message}. App editing is paused to protect your data.`;
        document.getElementById('app').inert = true;
    }
    display();
    return api;
};
