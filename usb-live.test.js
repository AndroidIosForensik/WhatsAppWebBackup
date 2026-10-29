const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { untar } = require('./usb-backup')._test;
const { parseWal, analyzeLive, walMessageIds, walSummary, writeWalReport } = require('./usb-wal');

// Legt eine laufende "App-Datenbank" an: altes Log (wird veraltet), Checkpoint,
// danach neue/geänderte/gelöschte Nachricht NUR im Log. Kopiert db + wal, während
// die Verbindung offen ist (wie beim Abzug vom Handy).
function liveDatabaseWithStaleFrames(dir) {
    const src = path.join(dir, 'handy');
    const raw = path.join(dir, 'roh');
    fs.mkdirSync(src); fs.mkdirSync(raw);
    const db = new DatabaseSync(path.join(src, 'msgstore.db'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE jid (_id INTEGER PRIMARY KEY, raw_string TEXT);
        CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER, subject TEXT);
        CREATE TABLE message (_id INTEGER PRIMARY KEY, chat_row_id INTEGER, from_me INTEGER,
            timestamp INTEGER, message_type INTEGER, text_data TEXT);
        CREATE TABLE fueller (x BLOB);
        INSERT INTO jid VALUES (1, '4911@s.whatsapp.net');
        INSERT INTO chat VALUES (1, 1, NULL);
        INSERT INTO message VALUES (1, 1, 0, 1700000000000, 0, 'bleibt'),
            (2, 1, 1, 1700000001000, 0, 'vorher'), (3, 1, 0, 1700000002000, 0, 'wird gelöscht');`);
    for (let i = 0; i < 40; i++) db.exec('INSERT INTO fueller VALUES (randomblob(3000))');
    db.exec('PRAGMA wal_checkpoint(RESTART)'); // alles in der Hauptdatei; Log wird neu begonnen
    db.exec("INSERT INTO message VALUES (4, 1, 0, 1700000003000, 0, 'neu, nur im Log')");
    db.exec("UPDATE message SET text_data = 'nachher' WHERE _id = 2");
    db.exec('DELETE FROM message WHERE _id = 3');
    for (const f of ['msgstore.db', 'msgstore.db-wal']) fs.copyFileSync(path.join(src, f), path.join(raw, f));
    db.close();
    const work = path.join(dir, 'arbeit');
    fs.mkdirSync(work);
    for (const f of ['msgstore.db', 'msgstore.db-wal']) fs.copyFileSync(path.join(raw, f), path.join(work, f));
    const merged = new DatabaseSync(path.join(work, 'msgstore.db'));
    merged.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    merged.close();
    return { raw, merged: path.join(work, 'msgstore.db') };
}

test('WAL-Bericht: Frames, veraltete Reste und Inhalt des Logs werden dokumentiert', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wal-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { raw, merged } = liveDatabaseWithStaleFrames(dir);

    const parsed = parseWal(fs.readFileSync(path.join(raw, 'msgstore.db-wal')));
    assert.equal(parsed.gueltig, true);
    assert.equal(parsed.header.kopfPruefsummeOk, true);
    assert.equal(parsed.stat.transaktionen, 3);           // INSERT, UPDATE, DELETE
    assert.ok(parsed.stat.veraltet > 0, 'alte Log-Runde muss als veraltet erkannt werden');
    assert.equal(parsed.stat.nichtFestgeschrieben, 0);

    const report = analyzeLive({ name: 'msgstore.db', remoteDir: '/data/data/com.whatsapp/databases',
        rawDir: raw, merged, files: [], workDir: path.join(dir, 'wal'), nameFor: () => 'Anna' });
    const msg = report.tabellen.find((x) => x.tabelle === 'message');
    assert.deepEqual([msg.neu, msg.geaendert, msg.geloescht], [1, 1, 1]);
    assert.equal(report.tabellen.find((x) => x.tabelle === 'fueller'), undefined, 'nicht betroffene Tabellen bleiben außen vor');
    assert.equal(report.nachrichten.neu[0].text, 'neu, nur im Log');
    assert.equal(report.nachrichten.neu[0].chat, 'Anna (4911@s.whatsapp.net)');
    assert.equal(report.nachrichten.geaendert[0].vorher.text, 'vorher');
    assert.equal(report.nachrichten.geaendert[0].nachher.text, 'nachher');
    assert.equal(report.nachrichten.geloescht[0].text, 'wird gelöscht');
    assert.deepEqual(msg.details.geaendert[0].spalten, ['text_data']);
    const ids = walMessageIds(report);
    assert.ok(ids.neu.has(4) && ids.geaendert.has(2) && !ids.neu.has(1));
    assert.match(walSummary([report]), /3 Transaktionen.*1 neu, 1 geändert, 1 gelöscht/);

    const out = path.join(dir, 'export');
    fs.mkdirSync(out);
    writeWalReport(out, [report]);
    const html = fs.readFileSync(path.join(out, 'wal-bericht.html'), 'utf8');
    assert.ok(html.includes('wird gelöscht') && html.includes('neu, nur im Log'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'wal-bericht.json'), 'utf8')).datenbanken[0].datenbank, 'msgstore.db');
});

test('parseWal: kaputte oder fremde Dateien werden benannt statt stillschweigend übergangen', () => {
    assert.equal(parseWal(Buffer.alloc(0)).grund, 'leer');
    assert.equal(parseWal(Buffer.alloc(40)).grund, 'keine WAL-Kennung');
});

// Nachbau des Root-Live-Abzugs: msgstore.db + -wal kommen per tar; die neuesten
// Nachrichten stehen NUR im Write-Ahead-Log und müssen nach dem Einarbeiten da sein.
test('Live-Abzug per tar: Nachrichten aus dem Write-Ahead-Log gehen nicht verloren', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-live-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const src = path.join(dir, 'handy');
    fs.mkdirSync(src);
    const db = new DatabaseSync(path.join(src, 'msgstore.db'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE message (text_data TEXT); INSERT INTO message VALUES ('alt');`);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec("INSERT INTO message VALUES ('neu, nur im Log')");
    // Verbindung offen lassen: wie bei laufender App bleibt das Log ungeschrieben.
    assert.ok(fs.statSync(path.join(src, 'msgstore.db-wal')).size > 0);
    const tarFile = path.join(dir, 'abzug.tar');
    const r = spawnSync('tar', ['-cf', path.relative(src, tarFile), 'msgstore.db', 'msgstore.db-wal'], { cwd: src, encoding: 'utf8' });
    db.close();
    if (r.error) { t.skip('tar nicht verfügbar'); return; }
    assert.equal(r.status, 0, r.stderr);

    const files = untar(fs.readFileSync(tarFile));
    assert.deepEqual(files.map((f) => f.name).sort(), ['msgstore.db', 'msgstore.db-wal']);
    const out = path.join(dir, 'pc');
    fs.mkdirSync(out);
    for (const f of files) fs.writeFileSync(path.join(out, f.name), f.data);
    const copy = new DatabaseSync(path.join(out, 'msgstore.db'));
    copy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.deepEqual(copy.prepare('SELECT text_data FROM message').all().map((x) => x.text_data), ['alt', 'neu, nur im Log']);
    copy.close();
});
