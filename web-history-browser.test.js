const test = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { readHistoryBatch } = require('./web-history');

test('Browseradapter scrollt und sammelt ältere Nachrichten ohne Duplikatverlust', async () => {
    const browser = await puppeteer.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<div id="main"><div style="height:200px;overflow-y:auto"><div style="height:900px">Verlauf</div></div></div>');
        await page.evaluate(() => {
            document.querySelector('#main > div').scrollTop = 200;
            const newer = { id: { _serialized: 'new' }, t: 20 };
            const older = { id: { _serialized: 'old' }, t: 10 };
            let models = [newer];
            const chat = { msgs: { getModelsArray: () => models, msgLoadState: { noEarlierMsgs: false } } };
            window.WWebJS = { getChat: async () => chat, getMessageModel: (m) => m };
            window.require = () => ({ loadEarlierMsgs: async () => {
                models = [older, { isNotification: true }];
                chat.msgs.msgLoadState.noEarlierMsgs = true;
                return [older];
            } });
        });
        const batch = await readHistoryBatch({ pupPage: page }, 'chat', true);
        assert.equal(batch.noEarlier, true);
        assert.deepEqual([...new Set(batch.messages.map((m) => m.id._serialized))], ['new', 'old']);
        assert.equal(await page.evaluate(() => document.querySelector('#main > div').scrollTop), 0);
    } finally { await browser.close(); }
});
