const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(operation, ms = 60000) {
    let timer;
    try {
        return await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Zeitüberschreitung beim Laden des Verlaufs')), ms);
            })
        ]);
    } finally { clearTimeout(timer); }
}

// Ein begrenzter Aufruf je Lade-Schritt hält die Fortschrittsanzeige am Leben.
// Dieselbe WhatsApp-Funktion wie fetchMessages, ergänzt um sichtbares Scrollen.
async function readHistoryBatch(client, chatId, load) {
    return withTimeout(() => client.pupPage.evaluate(async (id, loadEarlier) => {
        const chat = await window.WWebJS.getChat(id, { getAsModel: false });
        const collect = (models) => models.filter((m) => !m.isNotification)
            .map((m) => window.WWebJS.getMessageModel(m));
        const before = collect(chat.msgs.getModelsArray());
        let loaded = [];
        if (loadEarlier) {
            const main = document.querySelector('#main');
            if (main) {
                const panels = [...main.querySelectorAll('div')].filter((el) =>
                    el.scrollHeight > el.clientHeight && el.clientHeight > 100
                    && /auto|scroll/.test(getComputedStyle(el).overflowY));
                const panel = panels.sort((a, b) => b.clientHeight - a.clientHeight)[0];
                if (panel) {
                    panel.scrollTop = 0;
                    panel.dispatchEvent(new Event('scroll', { bubbles: true }));
                }
            }
            loaded = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat }) || [];
        }
        const state = chat.msgs.msgLoadState;
        const noEarlier = state && (state.noEarlierMsgs === true
            || (typeof state.get === 'function' && state.get('noEarlierMsgs') === true));
        return {
            messages: [...before, ...collect(loaded), ...collect(chat.msgs.getModelsArray())],
            noEarlier: !!noEarlier
        };
    }, chatId, load));
}

function messageId(m) {
    return typeof m.id === 'string' ? m.id : m.id && (m.id._serialized || m.id.$1);
}

async function loadChatHistory(client, chat, options = {}) {
    const read = options.read || readHistoryBatch;
    const wait = options.sleep || sleep;
    const idleLimit = options.idleLimit || 5;
    const onProgress = options.onProgress || (() => {});
    const warnings = [];
    const id = chat.id._serialized;
    if (client.interface) {
        try { await withTimeout(() => client.interface.openChatWindow(id)); }
        catch (e) { warnings.push('Chatfenster: ' + e.message); }
    }
    if (typeof chat.syncHistory === 'function') {
        try {
            if (await withTimeout(() => chat.syncHistory())) await wait(3000);
        } catch (e) { warnings.push('Historien-Synchronisierung: ' + e.message); }
    }
    const messages = new Map();
    let oldest = Infinity;
    let idle = 0;
    let step = 0;
    let batch;
    do {
        batch = await read(client, id, step > 0);
        let olderAdded = false;
        for (const m of batch.messages) {
            const key = messageId(m);
            if (!key) throw new Error('Nachricht ohne eindeutige ID; Ladephase abgebrochen');
            const ts = Number(m.t);
            if (!messages.has(key) && Number.isFinite(ts) && ts <= oldest) olderAdded = true;
            messages.set(key, m);
        }
        for (const m of batch.messages) {
            const ts = Number(m.t);
            if (Number.isFinite(ts)) oldest = Math.min(oldest, ts);
        }
        idle = olderAdded || step === 0 ? 0 : idle + 1;
        onProgress({ messages: messages.size, oldest: Number.isFinite(oldest) ? oldest : null, idle });
        step++;
        if (idle < idleLimit) await wait(3000);
    } while (idle < idleLimit);

    return {
        messages: [...messages.values()].sort((a, b) => a.t - b.t),
        report: {
            chatId: id, name: chat.name || chat.id.user, messages: messages.size,
            oldest: Number.isFinite(oldest) ? new Date(oldest * 1000).toISOString() : null,
            status: batch.noEarlier ? 'web-history-end' : 'stalled',
            warnings,
            note: batch.noEarlier
                ? 'WhatsApp Web meldet keine früheren Nachrichten. Vollständigkeit gegenüber dem Handy nicht nachweisbar.'
                : 'Nach fünf Ladeversuchen keine älteren Nachrichten erhalten. Verlaufsanfang nicht bestätigt.'
        }
    };
}

// Erst ALLE ausgewählten Chats laden, dann exportieren. Rohdaten liegen bis dahin
// temporär auf der Platte, damit ein Chatwechsel keine Nachrichten verdrängt.
async function prepareHistories(client, chats, onProgress = () => {}, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-history-'));
    const files = new Map();
    const reports = [];
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
        for (let i = 0; i < chats.length; i++) {
            const result = await loadChatHistory(client, chats[i], {
                ...options,
                onProgress: (p) => onProgress(chats[i], i, p)
            });
            const file = path.join(dir, `${i}.json`);
            fs.writeFileSync(file, JSON.stringify(result.messages), { mode: 0o600 });
            files.set(chats[i].id._serialized, file);
            reports.push(result.report);
        }
        return {
            reports, cleanup,
            read: (id) => JSON.parse(fs.readFileSync(files.get(id), 'utf8'))
        };
    } catch (e) { cleanup(); throw e; }
}

function selectMessages(messages, limit, since) {
    const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
    const limited = limit > 0 ? sorted.slice(-limit) : sorted;
    return since ? limited.filter((m) => m.timestamp >= since) : limited;
}

module.exports = { loadChatHistory, prepareHistories, readHistoryBatch, selectMessages, withTimeout };
