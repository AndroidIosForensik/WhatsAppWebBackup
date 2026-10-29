const test = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { downloadFromSnapshot } = require('./web-media');

test('Medienabruf funktioniert ohne Live-Modell und mediaData aus dem Snapshot', async () => {
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.evaluate(() => {
            window.expectedMime = 'image/jpeg';
            window.WWebJS = { arrayBufferToBase64Async: async (buffer) =>
                btoa(String.fromCharCode(...new Uint8Array(buffer))) };
            window.require = (name) => {
                if (name === 'WAWebCollections') return { Msg: {
                    get: () => undefined, getMessagesById: async () => { throw new Error('IndexedDB nicht verfügbar'); }
                } };
                if (name === 'WAWebDownloadManager') return { downloadManager: {
                    downloadAndMaybeDecrypt: async (options) => {
                        window.received = { directPath: options.directPath, mediaKey: options.mediaKey, mimetype: options.mimetype };
                        // Regression aus wwebjs/whatsapp-web.js#201908: Ohne MIME
                        // lehnt der aktuelle DownloadManager auch gültige Medien ab.
                        if (options.mimetype !== window.expectedMime) {
                            const error = new Error('InvalidMediaFileType');
                            error.name = 'InvalidMediaFileType';
                            throw error;
                        }
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
        assert.deepEqual(await page.evaluate(() => window.received), {
            directPath: '/test.enc', mediaKey: 'test-key', mimetype: 'image/jpeg'
        });
        for (const [type, mimetype] of [['video', 'video/mp4'], ['ptt', 'audio/ogg'],
            ['document', 'application/pdf'], ['sticker', 'image/webp']]) {
            await page.evaluate((mime) => { window.expectedMime = mime; }, mimetype);
            const media = await downloadFromSnapshot({ pupPage: page }, {
                id: { _serialized: 'test' }, _data: { directPath: '/test.enc', mediaKey: 'test-key', type, mimetype }
            });
            assert.equal(media.data, 'AQID');
            assert.equal(media.mimetype, mimetype);
        }
        await page.evaluate(() => {
            window.require = () => ({ Msg: { get: () => undefined, getMessagesById: async () => [] },
                downloadManager: { downloadAndMaybeDecrypt: async () => {
                    throw new Error('InvalidMediaFileType https://example.invalid/file?key=secret ' + 'a'.repeat(64));
                } } });
        });
        await assert.rejects(downloadFromSnapshot({ pupPage: page }, {
            id: { _serialized: 'test' }, _data: { directPath: '/test.enc', mediaKey: 'test-key', type: 'image', mimetype: 'image/jpeg' }
        }), (e) => {
            assert.match(e.message, /InvalidMediaFileType/);
            assert.doesNotMatch(e.message, /example|secret|a{64}/);
            assert.equal(e.stage, 'download-decrypt');
            return true;
        });
    } finally { await browser.close(); }
});
