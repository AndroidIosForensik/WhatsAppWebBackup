const test = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { downloadFromSnapshot } = require('./web-media');

test('Medienabruf funktioniert ohne Live-Modell und mediaData aus dem Snapshot', async () => {
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.evaluate(() => {
            window.WWebJS = { arrayBufferToBase64Async: async (buffer) =>
                btoa(String.fromCharCode(...new Uint8Array(buffer))) };
            window.require = (name) => {
                if (name === 'WAWebCollections') return { Msg: {
                    get: () => undefined, getMessagesById: async () => { throw new Error('IndexedDB nicht verfügbar'); }
                } };
                if (name === 'WAWebDownloadManager') return { downloadManager: {
                    downloadAndMaybeDecrypt: async (options) => {
                        window.received = { directPath: options.directPath, mediaKey: options.mediaKey };
                        return new Uint8Array([1, 2, 3]).buffer;
                    }
                } };
                throw new Error('Unerwartetes Modul');
            };
        });
        const result = await downloadFromSnapshot({ pupPage: page }, {
            id: { _serialized: 'test' }, _data: { directPath: '/test.enc', mediaKey: 'test-key', type: 'image', mimetype: 'image/jpeg' }
        });
        assert.equal(result.data, 'AQID');
        assert.equal(result.mimetype, 'image/jpeg');
        assert.deepEqual(await page.evaluate(() => window.received), { directPath: '/test.enc', mediaKey: 'test-key' });
    } finally { await browser.close(); }
});
