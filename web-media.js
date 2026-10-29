const { withTimeout } = require('./web-history');

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isMediaMessage(msg) {
    return !!msg.hasMedia || MEDIA_TYPES.has(msg.type);
}

function errorInfo(error) {
    const status = Number(error && error.status) || null;
    let reason = error && error.message || 'Keine Mediendaten erhalten';
    // Keine signierten Download-URLs, Schlüssel oder langen Hashwerte protokollieren.
    reason = String(reason).replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[gekürzt]').slice(0, 240);
    return { status, reason, ...(error && error.stage ? { stage: error.stage } : {}) };
}

// Der normale Bibliotheksabruf setzt ein noch vorhandenes Live-Message-Modell
// mit mediaData voraus. Nach der Ladephase kann genau dieses Modell fehlen.
// Die gesicherten Download-/Entschlüsselungsmetadaten reichen für denselben
// WhatsApp-DownloadManager; es werden keine Schlüssel nach außen übertragen.
async function downloadFromSnapshot(client, msg) {
    const snapshot = msg._data || {};
    const id = msg.id && (msg.id._serialized || msg.id.$1);
    const result = await withTimeout(() => client.pupPage.evaluate(async (messageId, raw) => {
        let live;
        try {
            const collection = window.require('WAWebCollections').Msg;
            live = collection.get(messageId);
            if (!live) live = (await collection.getMessagesById([messageId]))?.messages?.[0];
        } catch { /* Ein IndexedDB-/Cache-Fehler darf den Snapshot-Abruf nicht verhindern. */ }

        const readMetadata = () => {
            const data = {};
            for (const key of ['directPath', 'encFilehash', 'filehash', 'mediaKey',
                'mediaKeyTimestamp', 'type', 'mimetype', 'filename', 'size']) {
                data[key] = live && live[key] != null ? live[key] : raw[key];
            }
            return data;
        };
        let data = readMetadata();
        if ((!data.directPath || !data.mediaKey) && live && typeof live.downloadMedia === 'function') {
            try { await live.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 }); }
            catch { /* Anschließend explizit prüfen, ob Metadaten verfügbar sind. */ }
            data = readMetadata();
        }
        if (!data.directPath || !data.mediaKey) {
            return { error: { status: null, stage: 'metadata', reason: 'Downloadpfad oder Medienschlüssel nicht verfügbar' } };
        }
        try {
            const qpl = { addAnnotations() { return this; }, addPoint() { return this; } };
            const bytes = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
                directPath: data.directPath, encFilehash: data.encFilehash, filehash: data.filehash,
                mediaKey: data.mediaKey, mediaKeyTimestamp: data.mediaKeyTimestamp, type: data.type,
                mimetype: data.mimetype,
                signal: new AbortController().signal, downloadQpl: qpl
            });
            return {
                data: await window.WWebJS.arrayBufferToBase64Async(bytes),
                mimetype: data.mimetype, filename: data.filename, filesize: data.size
            };
        } catch (e) {
            // Die Ursache erhalten, aber URLs, Schlüssel und lange Hashwerte redigieren.
            const reason = String(e.message || e.name || e || 'Unbekannter Fehler')
                .replace(/https?:\/\/\S+/gi, '[URL]')
                .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[gekürzt]').slice(0, 240);
            return { error: { status: Number(e.status) || null, stage: 'download-decrypt',
                reason: 'WhatsApp-Medienabruf: ' + reason } };
        }
    }, id, snapshot));
    if (result && result.error) {
        const error = new Error(result.error.reason);
        error.status = result.error.status;
        error.stage = result.error.stage;
        throw error;
    }
    return result;
}

async function downloadWebMedia(client, msg, options = {}) {
    const fallback = options.fallback || downloadFromSnapshot;
    const wait = options.sleep || sleep;
    const attempts = options.attempts || 3;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let media;
        try {
            if (typeof msg.downloadMedia === 'function') {
                media = await withTimeout(() => msg.downloadMedia());
            }
        } catch (e) { lastError = e; }
        if (media && media.data) return media;
        try {
            media = await fallback(client, msg);
            if (media && media.data) return media;
            lastError = new Error('WhatsApp hat keine Mediendaten geliefert');
        } catch (e) { lastError = e; }
        // Nicht verfügbare Serverdateien werden nicht durch weitere Abrufe wiederhergestellt.
        if (Number(lastError && lastError.status) === 404 || Number(lastError && lastError.status) === 410) break;
        if (attempt < attempts) await wait(1500 * attempt);
    }
    const info = errorInfo(lastError);
    const error = new Error(info.reason);
    error.status = info.status;
    error.stage = info.stage;
    throw error;
}

module.exports = { isMediaMessage, downloadWebMedia, downloadFromSnapshot, errorInfo };
