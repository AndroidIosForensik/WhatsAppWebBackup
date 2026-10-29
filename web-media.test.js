const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isMediaMessage, downloadWebMedia, errorInfo } = require('./web-media');

const media = { data: 'AQID', mimetype: 'image/jpeg' };
const noWait = { sleep: async () => {} };

test('normaler Medienabruf benötigt keinen Snapshot-Fallback', async () => {
    const result = await downloadWebMedia({}, { downloadMedia: async () => media }, {
        fallback: async () => { throw new Error('Fallback darf nicht aufgerufen werden'); }
    });
    assert.equal(result, media);
});

test('fehlendes oder defektes Live-Modell nutzt den Snapshot', async () => {
    for (const downloadMedia of [async () => undefined, async () => { throw new Error('Modell fehlt'); }]) {
        let called = 0;
        const result = await downloadWebMedia({}, { downloadMedia }, {
            fallback: async () => { called++; return media; }
        });
        assert.equal(result, media);
        assert.equal(called, 1);
    }
});

test('vorübergehende Medienfehler werden erneut versucht', async () => {
    let attempts = 0;
    const result = await downloadWebMedia({}, {}, { ...noWait,
        fallback: async () => { if (++attempts < 3) throw new Error('Noch nicht bereit'); return media; }
    });
    assert.equal(result, media);
    assert.equal(attempts, 3);
});

test('HTTP 404 wird als fehlende Serverdatei gemeldet', async () => {
    let attempts = 0;
    await assert.rejects(downloadWebMedia({}, {}, { ...noWait, fallback: async () => {
        attempts++;
        const e = new Error('Serverdatei fehlt'); e.status = 404; throw e;
    } }), (e) => e.status === 404);
    assert.equal(attempts, 1);
});

test('Medientyp ohne directPath bleibt als Medium erkennbar', () => {
    for (const type of ['image', 'video', 'ptt', 'audio', 'document', 'sticker']) {
        assert.equal(isMediaMessage({ type, hasMedia: false }), true);
    }
    assert.equal(isMediaMessage({ type: 'chat', hasMedia: false }), false);
});

test('Fehlerbericht enthält keine signierten URLs oder langen Schlüssel', () => {
    const e = new Error('Abruf https://example.invalid/file?token=geheim ' + 'a'.repeat(64));
    const info = errorInfo(e);
    assert.doesNotMatch(info.reason, /example|geheim|a{64}/);
});

test('Web-Export schreibt Mediendatei und HTML-Verweis auch ohne hasMedia-Flag', async (t) => {
    const backup = require('./backup');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-export-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    backup.setOutputDir(dir);
    const msg = {
        id: { _serialized: 'true_test_ABC', id: 'ABC' }, timestamp: 1000,
        fromMe: true, type: 'image', hasMedia: false, body: '',
        downloadMedia: async () => media
    };
    const result = await backup._test.backupChat({}, { name: 'Test', id: { _serialized: 'test' } },
        new Set(), new Map(), () => {}, [msg]);
    assert.equal(result.media, 1);
    assert.equal(result.mediaFailed, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'Test', 'media', result.records[0].mediaFile)), Buffer.from([1, 2, 3]));
    const html = fs.readFileSync(path.join(dir, 'Test', 'chat.html'), 'utf8');
    assert.ok(html.includes('media/' + result.records[0].mediaFile));
});

test('Web-Export hält fehlgeschlagene Downloads in messages.json fest', async (t) => {
    const backup = require('./backup');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-failed-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    backup.setOutputDir(dir);
    const client = { pupPage: { evaluate: async () => ({ error: { status: 404, reason: 'Datei fehlt' } }) } };
    const msg = {
        id: { _serialized: 'true_test_DEF', id: 'DEF' }, timestamp: 1000,
        fromMe: true, type: 'video', hasMedia: true, downloadMedia: async () => undefined
    };
    const result = await backup._test.backupChat(client, { name: 'Test', id: { _serialized: 'test' } },
        new Set(), new Map(), () => {}, [msg]);
    assert.equal(result.mediaFailed, 1);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'Test', 'messages.json')));
    assert.equal(data.messages[0].mediaError.status, 404);
    assert.equal(data.messages[0].mediaFile, null);
});
