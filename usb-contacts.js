const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { decryptDatabase } = require('./usb-decrypt');

// Kontakt-Backup aus demselben WhatsApp-Verzeichnis wie die Nachrichtendatenbank.
function contactBackupPath(remoteDb) {
    return path.posix.join(path.posix.dirname(path.posix.dirname(remoteDb)), 'Backups', 'wa.db.crypt15');
}

function pullContactsDatabase({ remoteDb, workRoot, key, python, rootDb = null,
    exists, pull, log = console.log, decrypt = decryptDatabase }) {
    const remote = contactBackupPath(remoteDb);
    log('\nSuche Kontaktsicherung: ' + remote);
    if (!exists(remote)) {
        log('Keine wa.db.crypt15 gefunden.' + (rootDb ? ' Verwende die per Root gelesene wa.db.' : ' Kontaktnamen können fehlen.'));
        return rootDb;
    }
    try {
        const encrypted = path.join(workRoot, 'wa.db.crypt15');
        const decoded = path.join(workRoot, 'wa-backup.db');
        log('Ziehe und entschlüssele Kontaktsicherung ...');
        pull(remote, encrypted);
        decrypt(encrypted, key, decoded, python);
        log('Kontaktsicherung entschlüsselt und geprüft.');
        return decoded;
    } catch (error) {
        log('Warnung: Kontaktsicherung konnte nicht übernommen werden: ' + error.message);
        log(rootDb ? 'Verwende die per Root gelesene wa.db.' : 'Chat-Export wird ohne diese Kontaktnamen fortgesetzt.');
        return rootDb;
    }
}

// Kontaktverzeichnis: jid -> { name, waName, number }
//   name   = Name im Adressbuch des Handys (display_name bzw. Vor-/Nachname)
//   waName = von der Person selbst gewählter WhatsApp-Profilname (wa_name)
//   number = Telefonnummer
// Quellen in wa.db: wa_contacts (Telefonnummer-JIDs) und wa_address_book
// (neuere @lid-JIDs, WhatsApp ab 2025). Fehlende Spalten/Tabellen sind erlaubt.
function loadContacts(waDbPath, log = console.log) {
    const contacts = new Map();
    if (!waDbPath) return contacts;
    let db;
    try {
        if (!fs.existsSync(waDbPath)) throw new Error('Datei nicht gefunden.');
        db = new DatabaseSync(waDbPath, { readOnly: true });
        let rows = 0, found = false;
        for (const table of ['wa_contacts', 'wa_address_book']) {
            const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
            const wanted = ['display_name', 'wa_name', 'given_name', 'family_name', 'number'].filter(c => columns.has(c));
            if (!columns.has('jid') || !wanted.length) continue;
            found = true;
            for (const row of db.prepare(`SELECT jid, ${wanted.join(', ')} FROM ${table}`).all()) {
                rows++;
                if (row.jid) mergeContact(contacts, row.jid, contactFromRow(row));
            }
        }
        if (!found) throw new Error('Kein unterstütztes wa_contacts-Schema mit Namen gefunden.');
        const named = [...contacts.values()].filter(c => c.name || c.waName).length;
        log(`Kontaktsicherung: ${rows} Einträge, ${named} IDs mit Namen.`);
        if (!named) log('Hinweis: Die Kontaktsicherung enthält keine nutzbaren Namen. Nicht zugeordnete Chats behalten ihre Telefonnummer oder WhatsApp-ID.');
    } catch (error) {
        log('Warnung: Kontaktnamen konnten nicht gelesen werden: ' + error.message);
    } finally { if (db) db.close(); }
    return contacts;
}

function contactFromRow(row) {
    const text = value => typeof value === 'string' ? value.trim() : '';
    const digits = text(row.number).replace(/[^\d]/g, '');
    return {
        name: text(row.display_name) || [text(row.given_name), text(row.family_name)].filter(Boolean).join(' '),
        waName: text(row.wa_name),
        number: digits ? '+' + digits : ''
    };
}

// Fehlende Felder eines Eintrags auffüllen; vorhandene Angaben bleiben.
function mergeContact(contacts, jid, info) {
    const cur = contacts.get(jid) || { name: '', waName: '', number: '' };
    contacts.set(jid, {
        name: cur.name || info.name || '',
        waName: cur.waName || info.waName || '',
        number: cur.number || info.number || ''
    });
}
function mergeContacts(into, from) {
    for (const [jid, info] of from) mergeContact(into, jid, info);
    return into;
}

// Neuere Chats laufen unter @lid-IDs, die Namen stehen aber oft bei der
// Telefonnummer. msgstore.db/jid_map verknüpft beide - in beide Richtungen ergänzen.
function linkLids(contacts, msgDbPath, log = console.log) {
    let db;
    try {
        db = new DatabaseSync(msgDbPath, { readOnly: true });
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jid_map'").get()) return contacts;
        const pairs = db.prepare(`SELECT l.raw_string AS lid, p.raw_string AS pn FROM jid_map m
            JOIN jid l ON l._id = m.lid_row_id JOIN jid p ON p._id = m.jid_row_id`).all();
        for (const { lid, pn } of pairs) {
            if (!lid || !pn) continue;
            const phone = /^(\d+)@s\.whatsapp\.net$/.exec(pn);
            const own = { name: '', waName: '', number: phone ? '+' + phone[1] : '' };
            const a = contacts.get(lid), b = contacts.get(pn);
            for (const info of [a, b, own]) if (info) { mergeContact(contacts, lid, info); mergeContact(contacts, pn, info); }
        }
        log(`WhatsApp-IDs mit Telefonnummer verknüpft: ${pairs.length}.`);
    } catch (error) {
        log('Warnung: WhatsApp-IDs konnten nicht verknüpft werden: ' + error.message);
    } finally { if (db) db.close(); }
    return contacts;
}

// Angaben zu einer JID für Übersicht/Export; Nummer notfalls aus der JID selbst.
function contactInfo(contacts, jid) {
    const info = (contacts && contacts.get(jid)) || { name: '', waName: '', number: '' };
    const phone = /^(\d+)@(?:s\.whatsapp\.net|c\.us)$/.exec(jid || '');
    return { ...info, number: info.number || (phone && phone[1] !== '0' ? '+' + phone[1] : '') };
}

// Anzeigename wie in der App: Adressbuch > "~Profilname" > Nummer > WhatsApp-ID.
function makeNamer(contacts) {
    return jid => {
        if (!jid) return 'Unbekannt';
        if (jid === '0@s.whatsapp.net') return 'WhatsApp (System)';
        const info = contactInfo(contacts, jid);
        if (info.name) return info.name;
        if (info.waName) return '~' + info.waName;
        if (info.number) return info.number;
        const lid = /^(\d+)@lid$/.exec(jid);
        if (lid) return 'WhatsApp-ID ' + lid[1];
        return jid;
    };
}

module.exports = { contactBackupPath, pullContactsDatabase, loadContacts, mergeContacts, linkLids, contactInfo, makeNamer };
