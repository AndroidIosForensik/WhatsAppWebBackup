const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { describeSystemEvent, parseDatabase } = require('./usb-backup')._test;

const ev = (o) => ({ code: null, members: [], isMeJoined: false, privacyProvider: null, fromMe: false, actor: '', text: '', ...o });

test('Systemnachrichten: belegte Codes werden in Klartext übersetzt', () => {
    assert.equal(describeSystemEvent(ev({ code: 67, privacyProvider: 0, fromMe: true })).text, 'Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt');
    assert.equal(describeSystemEvent(ev({ code: 11, fromMe: true, text: 'Elite' })).text, 'Du hast die Gruppe „Elite“ erstellt');
    assert.equal(describeSystemEvent(ev({ code: 12, fromMe: true, members: ['Marv', 'Heini'] })).text, 'Du hast Marv und Heini hinzugefügt');
    assert.equal(describeSystemEvent(ev({ code: 14, actor: 'Anna', members: ['Bernd'] })).text, 'Anna hat Bernd entfernt');
    assert.equal(describeSystemEvent(ev({ code: 12, actor: 'Anna', isMeJoined: true })).text, 'Anna hat dich hinzugefügt');
    assert.equal(describeSystemEvent(ev({ code: 28, actor: 'Anna', oldNumber: '4911@s.whatsapp.net', newNumber: '4922@s.whatsapp.net' })).text,
        'Anna hat die Telefonnummer gewechselt (+4911 → +4922)');
    assert.equal(describeSystemEvent(ev({ code: 67, privacyProvider: 0 })).icon, '🔒');
});

test('Systemnachrichten: unbelegte Codes werden nicht geraten, sondern mit Nummer ausgegeben', () => {
    const r = describeSystemEvent(ev({ code: 52, fromMe: true, members: ['Marv'] }));
    assert.equal(r.text, 'Systemereignis (WhatsApp-Code 52) – betrifft: Marv');
    assert.equal(r.subtype, 'code-52');
    assert.equal(describeSystemEvent(ev({ code: 129 })).text, 'Systemereignis (WhatsApp-Code 129)');
    assert.equal(describeSystemEvent(ev({})).text, 'Systemereignis (WhatsApp-Code unbekannt)');
    assert.doesNotMatch(describeSystemEvent(ev({ code: 67, privacyProvider: 0 })).text, /Gruppen-Update/);
});

// Nachbau der echten Gruppe "Elite" (Schema und Werte wie am Gerät, 09/2026).
test('Gruppenverlauf aus message_system* wird mit Namen dekodiert; eigene @lid wird als "Du" erkannt', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-system-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'msgstore.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE jid (_id INTEGER PRIMARY KEY, raw_string TEXT);
        CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER, subject TEXT);
        CREATE TABLE message (_id INTEGER PRIMARY KEY, chat_row_id INTEGER, from_me INTEGER, timestamp INTEGER,
            message_type INTEGER, text_data TEXT, sender_jid_row_id INTEGER);
        CREATE TABLE message_system (message_row_id INTEGER, action_type INTEGER);
        CREATE TABLE message_system_chat_participant (message_row_id INTEGER, user_jid_row_id INTEGER);
        CREATE TABLE message_system_group (message_row_id INTEGER, is_me_joined INTEGER);
        CREATE TABLE message_system_initial_privacy_provider (message_row_id INTEGER, privacy_provider INTEGER);
        INSERT INTO jid VALUES (1, '120363@g.us'), (2, '999@lid'), (6, '111@lid'), (13, '222@lid');
        INSERT INTO chat VALUES (1, 1, 'Elite');
        INSERT INTO message VALUES
            (1, 1, 1, 1000, 7, 'Elite', 2), (2, 1, 1, 2000, 7, NULL, NULL), (3, 1, 1, 3000, 7, NULL, 2),
            (4, 1, 1, 4000, 7, NULL, 2), (5, 1, 1, 5000, 0, 'Hallo', 2);
        INSERT INTO message_system VALUES (1, 11), (2, 67), (3, 12), (4, 14);
        INSERT INTO message_system_initial_privacy_provider VALUES (2, 0);
        INSERT INTO message_system_chat_participant VALUES (3, 13), (3, 6), (4, 13);
        INSERT INTO message_system_group VALUES (1, 0), (3, 0), (4, 0);`);
    db.close();
    const contacts = new Map([
        ['111@lid', { name: 'Heini', waName: '', number: '+4917' }],
        ['222@lid', { name: 'Marv', waName: '', number: '+4918' }]
    ]);
    const { entries } = parseDatabase(file, contacts, null, path.join(dir, 'out'));
    const texts = entries[0].records.filter((r) => r.type === 'gp2').map((r) => r.group.text);
    assert.deepEqual(texts, [
        'Du hast die Gruppe „Elite“ erstellt',
        'Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt',
        'Du hast Marv und Heini hinzugefügt',
        'Du hast Marv entfernt'
    ]);
    const html = fs.readFileSync(path.join(dir, 'out', entries[0].dir, 'chat.html'), 'utf8');
    assert.ok(html.includes('🔒 Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt'));
    assert.ok(!html.includes('Gruppen-Update'));
});
