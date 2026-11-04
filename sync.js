/* Durable, ordered change outbox. Database acceptance orders same-field edits. */
window.createMayaSync = async function ({ client, getState, applyState, canRefresh, hasDraft = () => false }) {
    const { dataOnly, changesBetween } = window.MayaChanges;
    const clone = value => structuredClone(value);
    const app = document.getElementById('app');
    const $ = id => document.getElementById(id);
    const source = cloud => cloud?.device_name || cloud?.payload?._syncSource?.deviceName || 'Unknown device';
    const format = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not available';
    const defaultName = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'My Phone' : 'My PC';
    let db, record, ready = false, busy = false, applying = false, durable = false;
    let networkUnavailable = false, configError = false, fatal = '', chain = Promise.resolve();
    let localVersion = 0, durableVersion = -1, retryTimer;
    app.inert = true;
    function display() {
        let text;
        if (fatal) text = fatal;
        else if (!ready) text = 'Opening device storage…';
        else if (!durable) text = 'Couldn’t save on this device — download a backup';
        else if (durableVersion < localVersion) text = 'Saving on this device…';
        else if (record.legacyPending || record.review) text = record.review || 'Previous app version has pending data — review the preserved copy';
        else if (configError) text = 'Cloud sync upgrade needed — changes saved on this device';
        else if (!navigator.onLine || networkUnavailable) text = 'Offline — changes saved on this device';
        else if (busy) text = 'Syncing changes…';
        else if (record.outbox.length) text = 'Changes saved on this device — waiting to sync';
        else if (record.revision != null) text = 'All changes saved to cloud';
        else text = 'Device ready — cloud connection not yet confirmed';
        $('sync-status').textContent = text;
        $('sync-status').dataset.state = !durable ? 'error' : (!navigator.onLine || networkUnavailable) ? 'offline' : busy ? 'syncing' : 'saved';
        $('sync-cloud-time').textContent = record?.cloudSavedAt
            ? `Last cloud update: ${format(record.cloudSavedAt)} · ${record.cloudDeviceName || 'Unknown device'}` : 'Cloud update: Not available';
        $('sync-cloud-time').title = `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
        $('sync-local-time').textContent = `Local edit: ${format(record?.localEditedAt)}`;
        $('sync-notice').textContent = record?.notice || '';
        $('sync-notice').hidden = !record?.notice;
        const review = !!(record?.review || record?.legacyPending);
        $('use-cloud-btn').hidden = $('replace-cloud-btn').hidden = !review;
        $('save-device-btn').disabled = !ready || applying;
    }
    function transaction(mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('state', mode);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('Device storage failed'));
            operation(tx.objectStore('state'), value => { result = value; });
        });
    }
    async function persist(backup) {
        const version = ++localVersion;
        const snapshot = clone(record);
        try {
            await transaction('readwrite', store => {
                if (backup) store.put(clone(backup), `backup-${crypto.randomUUID()}`);
                store.put(snapshot, 'current');
            });
            durable = true;
            durableVersion = version;
            return true;
        } catch {
            durable = false;
            $('sync-options').open = true;
            display();
            return false;
        }
    }
    function enqueue(work) {
        chain = chain.then(work).catch(() => {
            networkUnavailable = true;
            display();
            schedule();
        });
        return chain;
    }
    function schedule() {
        clearTimeout(retryTimer);
        if (ready) retryTimer = setTimeout(() => api.refresh(), networkUnavailable ? 15000 : 10000);
    }
    async function callRpc(name, args) {
        if (!client) throw new Error('Cloud library unavailable');
        const controller = new AbortController();
        let timer;
        const request = client.rpc(name, args);
        try {
            return await Promise.race([
                typeof request.abortSignal === 'function' ? request.abortSignal(controller.signal) : request,
                new Promise((_, reject) => { timer = setTimeout(() => {
                    controller.abort(); reject(new Error('Connection timed out'));
                }, 12000); })
            ]);
        } finally { clearTimeout(timer); }
    }
    async function readCloud(full = true) {
        if (!client) throw new Error('Cloud library unavailable');
        const { data, error } = await callRpc(full ? 'maya_read_state' : 'maya_sync_status');
        if (error) throw error;
        if (data?.protocol !== 2) { configError = true; throw new Error('Cloud upgrade needed'); }
        if (!/^\d+$/.test(data.revision) || !/^\d+$/.test(data.epoch) || !/^\d+$/.test(data.aftersales_epoch)
            || (full && (!data.payload || Array.isArray(data.payload)))) throw new Error('Invalid cloud response');
        configError = false;
        networkUnavailable = false;
        return data;
    }
    function metadata(cloud) {
        record.cloudSavedAt = cloud.updated_at;
        record.cloudDeviceName = source(cloud);
    }
    async function adopt(cloud, backup) {
        if (!canRefresh() || record.outbox.length || (!backup && (record.legacyPending || record.review))) return false;
        applying = true;
        app.inert = true;
        const previous = clone(record);
        try {
            const preferences = clone(getState());
            const next = { ...preferences, ...dataOnly(cloud.payload) };
            next.editingEstablishmentId = next.viewingEstablishmentId = next.editingFilterId = null;
            record.state = next;
            record.revision = cloud.revision;
            record.epoch = cloud.epoch;
            record.aftersalesEpoch = cloud.aftersales_epoch;
            record.baselineUnknown = record.legacyPending = false;
            record.review = '';
            record.refreshNeeded = false;
            metadata(cloud);
            if (!await persist(backup)) { record = previous; return false; }
            applyState(clone(record.state));
            return true;
        } finally { applying = false; app.inert = false; }
    }
    function capture(intent) {
        const snapshot = clone(getState());
        const changes = changesBetween(record.state, snapshot, intent);
        if (changes.length) {
            record.localEditedAt = new Date().toISOString();
            if (record.baselineUnknown) record.legacyPending = true;
            if (!record.legacyPending) record.outbox.push({
                p_request_id: crypto.randomUUID(), p_epoch: record.epoch,
                p_aftersales_epoch: record.aftersalesEpoch,
                p_device_name: record.deviceName, p_changes: changes
            });
        }
        record.state = snapshot;
        localVersion++;
        display();
    }
    async function sync() {
        if (!ready || !durable || applying || record.legacyPending || record.review || !navigator.onLine) { display(); schedule(); return; }
        busy = true;
        display();
        try {
            let cloud = await readCloud(false);
            metadata(cloud);
            if (record.legacyPending || record.review) return;
            // New, empty installations may collect new entries before their first read.
            if (record.epoch === null && !record.baselineUnknown) {
                record.epoch = cloud.epoch;
                record.aftersalesEpoch = cloud.aftersales_epoch;
                for (const batch of record.outbox) {
                    batch.p_epoch ??= cloud.epoch;
                    batch.p_aftersales_epoch ??= cloud.aftersales_epoch;
                }
            }
            let sent = 0;
            while (record.outbox.length && sent++ < 20 && navigator.onLine) {
                // Persist immutable request identity and all later edits BEFORE sending.
                if (!await persist()) return;
                const batch = clone(record.outbox[0]);
                const { data, error } = await callRpc('maya_apply_changes', batch);
                if (error) throw error;
                if (data?.status === 'review_required') {
                    record.review = data.reason || 'A replacement or field change needs review';
                    await persist(); return;
                }
                if (!['saved', 'already_saved'].includes(data?.status) || data.request_id !== batch.p_request_id
                    || !/^\d+$/.test(data.revision) || !/^\d+$/.test(data.epoch) || !/^\d+$/.test(data.aftersales_epoch))
                    throw new Error('Invalid save acknowledgement');
                record.outbox.shift();
                record.refreshNeeded = true;
                // Remote group generations must NEVER rebind unsent stale edits.
                const resetAll = batch.p_changes.some(change => change.kind === 'replace_all');
                const resetAftersales = resetAll || batch.p_changes.some(change => change.kind === 'replace_aftersales');
                if (resetAll) {
                    record.epoch = data.epoch;
                    for (const queued of record.outbox) queued.p_epoch = data.epoch;
                }
                if (resetAftersales) {
                    record.aftersalesEpoch = data.aftersales_epoch;
                    for (const queued of record.outbox) queued.p_aftersales_epoch = data.aftersales_epoch;
                }
                record.revision = data.revision;
                record.cloudSavedAt = data.saved_at;
                record.cloudDeviceName = data.device_name;
                const skipped = Array.isArray(data.skipped) && data.skipped.length;
                if (skipped) record.notice = 'Some older edits targeted deleted records or fields. A recovery copy is under Options → Download preserved copies.';
                if (!await persist(skipped ? { batch, localState: record.state, skipped: data.skipped } : null)) return;
                networkUnavailable = false;
            }
            if (!record.outbox.length) {
                cloud = await readCloud(false);
                metadata(cloud);
                // Leave unfinished forms and their local comparison snapshot intact.
                if (!record.outbox.length && canRefresh() && (record.refreshNeeded || record.baselineUnknown || record.revision !== cloud.revision)) await adopt(await readCloud());
            }
        } catch (error) {
            if (error?.code === 'PGRST202' || error?.code === '42501') {
                configError = true;
            } else if (/^(22|P000)/.test(error?.code || '')) {
                record.review = 'A change needs review before syncing. Your pending data is preserved.';
                await persist();
            } else networkUnavailable = true;
        } finally { busy = false; display(); schedule(); }
    }
    const api = {
        save(intent) {
            if (!ready || applying) return;
            capture(intent);
            // Device writes must never wait behind a slow network request.
            return persist().then(stored => {
                display();
                if (stored) enqueue(sync);
            });
        },
        refresh() { return enqueue(sync); }
    };
    function download(value, name) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    $('download-local-btn').addEventListener('click', () => download({ ...record, state: getState() }, 'maya-device-backup.json'));
    $('download-history-btn').addEventListener('click', () => enqueue(async () => {
        if (!db) return;
        const backups = await transaction('readonly', (store, done) => {
            const entries = [];
            store.openCursor().onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) { done(entries); return; }
                if (String(cursor.key).startsWith('backup-')) entries.push({ key: cursor.key, copy: cursor.value });
                cursor.continue();
            };
        });
        download(backups, 'maya-preserved-device-copies.json');
    }));
    $('save-device-btn').addEventListener('click', async () => {
        await api.save();
        if (durable) $('sync-options').open = false;
    });
    document.addEventListener('pointerdown', event => {
        if (!$('sync-options').contains(event.target)) $('sync-options').open = false;
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') $('sync-options').open = false;
    });
    $('sync-now-btn').addEventListener('click', () => api.save());
    $('save-device-name-btn').addEventListener('click', () => enqueue(async () => {
        if (!ready) return;
        const name = $('device-name-input').value.trim();
        if (!name || name.length > 40) { $('device-name-feedback').textContent = 'Enter 1–40 characters.'; return; }
        record.deviceName = name;
        if (await persist()) $('device-name-feedback').textContent = 'Device name saved for future edits.';
        display();
    }));
    $('use-cloud-btn').addEventListener('click', () => enqueue(async () => {
        if (!canRefresh() || !confirm('Load the current cloud data? Your pending copy will be kept in device backups.')) return;
        const cloud = await readCloud();
        const backup = clone(record);
        record.outbox = [];
        if (!await adopt(cloud, backup)) record = backup;
        display();
    }));
    $('replace-cloud-btn').addEventListener('click', () => enqueue(async () => {
        if (!canRefresh()) return;
        const cloud = await readCloud();
        if (!confirm(`Replace the ENTIRE cloud dataset from ${format(cloud.updated_at)} with this device's records? A backup will be kept.`)) return;
        const backup = clone(record);
        record.outbox = [{ p_request_id: crypto.randomUUID(), p_epoch: cloud.epoch,
            p_aftersales_epoch: cloud.aftersales_epoch, p_device_name: record.deviceName,
            p_changes: [{ kind: 'replace_all', expected: dataOnly(cloud.payload), value: dataOnly(getState()) }] }];
        record.epoch = cloud.epoch; record.aftersalesEpoch = cloud.aftersales_epoch;
        record.review = ''; record.legacyPending = record.baselineUnknown = false;
        if (!await persist({ local: backup, cloud })) { record = backup; return; }
        enqueue(sync);
    }));
    window.addEventListener('offline', () => { networkUnavailable = true; display(); });
    window.addEventListener('online', () => { networkUnavailable = false; api.refresh(); });
    window.addEventListener('focus', () => api.refresh());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) api.refresh(); });
    window.addEventListener('beforeunload', event => {
        // A durable outbox is safe to reload; only unpersisted data/drafts need a warning.
        if (!durable || durableVersion < localVersion || hasDraft()) { event.preventDefault(); event.returnValue = ''; }
    });
    try {
        if (!navigator.locks) throw new Error('Use a current browser over HTTPS');
        let grant;
        const granted = new Promise(resolve => { grant = resolve; });
        navigator.locks.request('maya-sync-writer', { ifAvailable: true }, lock => {
            grant(!!lock); return lock ? new Promise(() => {}) : undefined;
        });
        if (!await granted) throw new Error('Another Maya tab is open. Close it and reload this tab');
        db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('maya-device-sync', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('state');
            request.onsuccess = () => resolve(request.result);
            request.onerror = request.onblocked = () => reject(new Error('Device storage unavailable'));
        });
        const old = await transaction('readonly', (store, done) => {
            store.get('current').onsuccess = event => done(event.target.result);
        });
        const legacyTouched = old?.protocol === 2 && (Object.hasOwn(old, 'dirty') || Object.hasOwn(old, 'pending'));
        if (old?.protocol === 2 && !legacyTouched) record = old;
        else {
            const legacy = old?.state || JSON.parse(localStorage.getItem('enterpriseDataManager') || 'null');
            record = { protocol: 2, state: legacy || clone(getState()), outbox: [],
                revision: old?.revision ?? null, epoch: null, aftersalesEpoch: null,
                deviceName: old?.deviceName || defaultName, localEditedAt: old?.localEditedAt || null,
                cloudSavedAt: old?.cloudSavedAt || null, cloudDeviceName: old?.cloudDeviceName,
                legacyPending: !!(legacyTouched || old?.dirty || old?.pending || (!old && legacy)),
                baselineUnknown: !!legacy, review: '', notice: '' };
        }
        $('device-name-input').value = record.deviceName;
        if (!await persist(old && (old.protocol !== 2 || legacyTouched) ? old : null)) throw new Error('Device storage unavailable');
        applyState(clone(record.state));
        // View-only defaults applied by the app are not pending data edits.
        record.state = clone(getState());
        if (!await persist()) throw new Error('Device storage unavailable');
        ready = true; app.inert = false;
        api.refresh();
    } catch (error) {
        fatal = `${error.message}. Editing is paused to protect your data.`;
        app.inert = true;
    }
    display();
    return api;
};
