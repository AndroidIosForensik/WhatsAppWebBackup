const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { contactBackupPath, pullContactsDatabase, loadContacts, linkLids, contactInfo, makeNamer } = require('./usb-contacts');
const { detectDecryptPython } = require('./usb-decrypt');

function workspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-contacts-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('Kontaktsicherung folgt dem Speicherort der Nachrichtensicherung', () => {
    for (const root of ['/sdcard/WhatsApp', '/sdcard/Android/media/com.whatsapp/WhatsApp']) {
        assert.equal(contactBackupPath(root + '/Databases/msgstore.db.crypt15'), root + '/Backups/wa.db.crypt15');
    }
});

test('fehlende und defekte optionale Sicherungen erhalten den Root-Fallback', () => {
    const logs = [];
    const options = { remoteDb: '/sdcard/WhatsApp/Databases/msgstore.db.crypt15',
        workRoot: '.', rootDb: 'root-wa.db', exists: () => false,
        log: s => logs.push(s), pull: () => { throw Error('Kopieren fehlgeschlagen'); } };
    assert.equal(pullContactsDatabase(options), 'root-wa.db');
    assert.equal(pullContactsDatabase({ ...options, exists: () => true }), 'root-wa.db');
    assert.ok(logs.some(s => s.includes('Kopieren fehlgeschlagen')));
    assert.equal(pullContactsDatabase({ ...options, rootDb: null }), null);
});

test('leere wa_contacts wird ausdrücklich gemeldet; optionale wa_name-Spalte darf fehlen', t => {
    const file = path.join(workspace(t), 'wa.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE wa_contacts (jid TEXT, display_name TEXT)');
    const logs = [];
    assert.equal(loadContacts(file, s => logs.push(s)).size, 0);
    assert.ok(logs.some(s => s.includes('0 Einträge')));
    db.exec("INSERT INTO wa_contacts VALUES ('123@lid', 'Testname')");
    db.close();
    assert.equal(loadContacts(file, () => {}).get('123@lid').name, 'Testname');
});

test('nur Telefonnummern bekommen ein Plus, interne IDs bleiben unterscheidbar', () => {
    const name = makeNamer(new Map([['123@lid', { name: 'Testname', waName: '', number: '' }]]));
    assert.equal(name('123@lid'), 'Testname');
    assert.equal(name('0@s.whatsapp.net'), 'WhatsApp (System)');
    assert.equal(name('456@lid'), 'WhatsApp-ID 456');
    assert.equal(name('491234@s.whatsapp.net'), '+491234');
    assert.equal(name('123@g.us'), '123@g.us');
});

test('verschlüsselte Kontaktsicherung liefert offline Chat- und Absendernamen', t => {
    const { python } = detectDecryptPython();
    if (!python) { t.skip('Python mit wa-crypt-tools erforderlich'); return; }
    const dir = workspace(t);
    const source = path.join(dir, 'source.db');
    const encrypted = path.join(dir, 'source.crypt15');
    const key = '33'.repeat(32);
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE wa_contacts (jid TEXT, display_name TEXT, wa_name TEXT);
        INSERT INTO wa_contacts VALUES ('123@lid', 'Kontakt Eins', 'Profil Eins');
        INSERT INTO wa_contacts VALUES ('491234@s.whatsapp.net', ' ', 'Profil Zwei');`);
    db.close();
    const result = spawnSync(python, ['-m', 'wa_crypt_tools.waencrypt', key, source, encrypted], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const remote = '/sdcard/Android/media/com.whatsapp/WhatsApp/Databases/msgstore.db.crypt15';
    const decoded = pullContactsDatabase({ remoteDb: remote, workRoot: dir, key, python,
        exists: p => p === contactBackupPath(remote), log: () => {},
        pull: (from, to) => { assert.equal(from, contactBackupPath(remote)); fs.copyFileSync(encrypted, to); } });
    assert.ok(decoded);
    const names = loadContacts(decoded, () => {});
    assert.deepEqual(names.get('123@lid'), { name: 'Kontakt Eins', waName: 'Profil Eins', number: '' });
    assert.equal(names.get('491234@s.whatsapp.net').waName, 'Profil Zwei');
    const messages = path.join(dir, 'msgstore.db');
    const msgDb = new DatabaseSync(messages);
    msgDb.exec(`CREATE TABLE jid (_id INTEGER, raw_string TEXT);
        CREATE TABLE chat (_id INTEGER, jid_row_id INTEGER, subject TEXT);
        CREATE TABLE message (_id INTEGER, from_me INTEGER, timestamp INTEGER,
            message_type INTEGER, text_data TEXT, sender_jid_row_id INTEGER, chat_row_id INTEGER);
        INSERT INTO jid VALUES (1, '123@lid'), (2, '491234@s.whatsapp.net');
        INSERT INTO chat VALUES (1, 1, NULL), (2, 2, NULL);
        INSERT INTO message VALUES (1, 0, 100000, 0, 'Test', 1, 1), (2, 0, 200000, 0, 'Test', 2, 2);`);
    msgDb.close();
    const output = path.join(dir, 'export');
    const { entries } = require('./usb-backup')._test.parseDatabase(messages, names, null, output);
    // Ohne Adressbuchnamen wie in der App: "~" + selbst gewählter Profilname.
    assert.deepEqual(entries.map(e => e.name), ['Kontakt Eins', '~Profil Zwei']);
    assert.deepEqual(entries[1].contact, { name: '', waName: 'Profil Zwei', number: '+491234' });
    for (const entry of entries) {
        const record = JSON.parse(fs.readFileSync(path.join(output, entry.dir, 'messages.json'), 'utf8'));
        assert.equal(record.messages[0].senderName, entry.name);
        assert.ok(fs.readFileSync(path.join(output, entry.dir, 'chat.html'), 'utf8').includes(entry.name));
    }
});

test('@lid-Chats bekommen Adressbuchname, WhatsApp-Name und Nummer (Schema wie echtes Gerät 09/2026)', t => {
    const dir = workspace(t);
    const waFile = path.join(dir, 'wa.db');
    const wa = new DatabaseSync(waFile);
    wa.exec(`CREATE TABLE wa_contacts (jid TEXT, display_name TEXT, given_name TEXT, family_name TEXT, wa_name TEXT, number TEXT);
        CREATE TABLE wa_address_book (jid TEXT, display_name TEXT, given_name TEXT, family_name TEXT, number TEXT);
        INSERT INTO wa_contacts VALUES ('4911@s.whatsapp.net', 'Anna', NULL, NULL, 'Anni', '+4911');
        INSERT INTO wa_contacts VALUES ('2347@s.whatsapp.net', NULL, NULL, NULL, 'Fremd', NULL);
        INSERT INTO wa_address_book VALUES ('333@lid', 'Bernd', NULL, NULL, '4933');`);
    wa.close();
    const msFile = path.join(dir, 'msgstore.db');
    const ms = new DatabaseSync(msFile);
    ms.exec(`CREATE TABLE jid (_id INTEGER, raw_string TEXT);
        CREATE TABLE jid_map (lid_row_id INTEGER, jid_row_id INTEGER);
        INSERT INTO jid VALUES (1, '111@lid'), (2, '4911@s.whatsapp.net'), (3, '222@lid'), (4, '2347@s.whatsapp.net'),
            (5, '444@lid'), (6, '4944@s.whatsapp.net');
        INSERT INTO jid_map VALUES (1, 2), (3, 4), (5, 6);`);
    ms.close();
    const contacts = linkLids(loadContacts(waFile, () => {}), msFile, () => {});
    const name = makeNamer(contacts);
    assert.deepEqual(contactInfo(contacts, '111@lid'), { name: 'Anna', waName: 'Anni', number: '+4911' });
    assert.equal(name('222@lid'), '~Fremd');
    assert.equal(contactInfo(contacts, '222@lid').number, '+2347');
    assert.equal(name('333@lid'), 'Bernd');
    assert.equal(contactInfo(contacts, '333@lid').number, '+4933');
    assert.equal(name('444@lid'), '+4944');          // nur Verknüpfung, keine Namen
    assert.equal(name('555@lid'), 'WhatsApp-ID 555'); // gar nicht zuordenbar
});
