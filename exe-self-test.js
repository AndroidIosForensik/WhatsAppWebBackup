// Offline-Prüfung der gebündelten EXE: keine WhatsApp-Anmeldung, keine Nutzdaten.
async function main() {
    const assert = require('node:assert/strict');
    const fs = require('fs');
    const path = require('path');
    require('./menu');
    require('./backup');
    require('./usb-backup');
    require('./web-history');
    require('./web-media');
    require('qrcode-terminal');
    require('whatsapp-web.js');
    assert.ok(fs.existsSync(path.join(__dirname, 'DOKUMENTATION.md')));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    assert.equal(db.prepare('SELECT 1 AS ok').get().ok, 1);
    db.close();
    const browser = await require('puppeteer').launch({
        headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });
    try {
        const page = await browser.newPage();
        await page.setContent('<title>WhatsApp-Backup Selbsttest</title>');
        assert.equal(await page.title(), 'WhatsApp-Backup Selbsttest');
    } finally { await browser.close(); }
    console.log('SELBSTTEST OK: Node ' + process.version + ', SQLite, Module und gebündelter Browser.');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
