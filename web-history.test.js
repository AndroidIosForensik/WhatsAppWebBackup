const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadChatHistory, prepareHistories, selectMessages, withTimeout } = require('./web-history');

const msg = (id, t) => ({ id: { _serialized: id }, t, body: id });
const chat = (id = 'test') => ({ id: { _serialized: id }, name: id });
const quick = { sleep: async () => {}, idleLimit: 3 };

test('lädt nach leerem Zwischenresultat weiter und behält verdrängte Nachrichten', async () => {
    const batches = [
        [msg('neu', 30)], [], [msg('alt', 10), msg('neu', 30)],
        [msg('älteste', 1)], [], [], []
    ];
    const flags = [];
    const result = await loadChatHistory({}, chat(), {
        ...quick, read: async (_, __, load) => {
            flags.push(load);
            return { messages: batches.shift(), noEarlier: batches.length === 0 };
        }
    });
    assert.deepEqual(result.messages.map((m) => m.id._serialized), ['älteste', 'alt', 'neu']);
    assert.equal(result.report.status, 'web-history-end');
    assert.equal(flags[0], false);
    assert.ok(flags.slice(1).every(Boolean));
});

test('neue eingehende Nachrichten verhindern den Stillstand-Abbruch nicht', async () => {
    let n = 0;
    const result = await loadChatHistory({}, chat(), {
        ...quick, read: async () => ({ messages: [msg('eingang' + n, 10 + n++)], noEarlier: false })
    });
    assert.equal(n, 4);
    assert.equal(result.report.status, 'stalled');
    assert.equal(result.messages.length, 4);
});

test('Fenster und Synchronisierung werden vor dem Nachladen ausgeführt', async () => {
    const events = [];
    await loadChatHistory({ interface: { openChatWindow: async () => events.push('open') } }, {
        ...chat(), syncHistory: async () => { events.push('sync'); return true; }
    }, { ...quick, read: async () => { events.push('read'); return { messages: [], noEarlier: true }; } });
    assert.deepEqual(events.slice(0, 3), ['open', 'sync', 'read']);
});

test('alle Chats werden vor dem Export vorbereitet und temporäre Daten entfernt', async () => {
    const events = [];
    const histories = await prepareHistories({}, [chat('a'), chat('b')], () => {}, {
        ...quick, read: async (_, id) => {
            events.push(id);
            return { messages: [msg(id, 1)], noEarlier: true };
        }
    });
    try {
        assert.deepEqual([...new Set(events)], ['a', 'b']);
        assert.equal(histories.read('a')[0].body, 'a');
        assert.equal(histories.reports.length, 2);
    } finally { histories.cleanup(); }
    assert.throws(() => histories.read('a'), { code: 'ENOENT' });
});

test('Ladefehler starten keinen Export und räumen den temporären Ordner auf', async () => {
    let file;
    const original = fs.writeFileSync;
    fs.writeFileSync = (...args) => { file = args[0]; return original(...args); };
    try {
        await assert.rejects(prepareHistories({}, [chat('a'), chat('b')], () => {}, {
            ...quick, read: async (_, id) => {
                if (id === 'b') throw new Error('Verbindung verloren');
                return { messages: [msg('a', 1)], noEarlier: true };
            }
        }), /Verbindung verloren/);
        assert.equal(fs.existsSync(file), false);
    } finally { fs.writeFileSync = original; }
});

test('Limit und Stichtag filtern erst nach dem vollständigen Laden', () => {
    const data = [1, 4, 2, 3].map((timestamp) => ({ timestamp }));
    assert.deepEqual(selectMessages(data, 2, 0).map((m) => m.timestamp), [3, 4]);
    assert.deepEqual(selectMessages(data, 0, 2).map((m) => m.timestamp), [2, 3, 4]);
    assert.deepEqual(selectMessages(data, 0, 0).map((m) => m.timestamp), [1, 2, 3, 4]);
});

test('hängender Ladeschritt bricht mit Fehler ab', async () => {
    await assert.rejects(withTimeout(() => new Promise(() => {}), 10), /Zeitüberschreitung/);
});
