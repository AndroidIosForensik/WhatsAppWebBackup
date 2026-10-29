/**
 * WhatsApp-Backup über USB (offline, ohne Internet)
 *
 * Zieht die WhatsApp-Datenbank und die Medien per ADB vom Handy, entschlüsselt
 * die Datenbank und exportiert alle Chats ins gleiche Format wie backup.js
 * (messages.json, chat.html, index.html, beweise.html, dokumentation.html,
 * manifest.json).
 *
 * Voraussetzungen:
 *   - Handy per USB verbunden, entsperrt, USB-Debugging an (Datei-/adb-Zugriff).
 *   - adb (Android Platform-Tools) im PATH.
 *   - Für die Entschlüsselung: Python + wa-crypt-tools  (pip install wa-crypt-tools).
 *
 * Schlüssel (für .crypt15):
 *   - Standard: Schlüssel-Screen in der App öffnen (WhatsApp > Einstellungen >
 *     Chats > Backup > E2E-verschlüsseltes Backup > Schlüssel anzeigen), dann
 *     [Enter] - das Skript liest ihn per uiautomator vom Bildschirm ab. Klappt
 *     das nicht (z. B. FLAG_SECURE), Schlüssel von Hand einfügen.
 *   - Mit --root: kein Schlüssel nötig. Liest die AKTUELLE msgstore.db und wa.db
 *     direkt aus /data/data/com.whatsapp/databases (inkl. Write-Ahead-Log) statt
 *     der bis zu einen Tag alten Sicherungsdatei. Nur wenn das scheitert:
 *     Sicherungsdatei + Schlüsseldatei per Root.
 *
 * Aufruf:  node usb-backup.js [--root] [--key <64hex>] [--db <datei>]
 *                             [--no-media] [--limit <n>] [--seit <Datum>]
 *          --seit  nur Nachrichten ab Datum (JJJJ-MM-TT), z. B. Anordnungszeitpunkt
 *
 * Lesende Zustandssicherung (kein Entschlüsseln, keine Schlüssel nötig):
 *   node usb-backup.js --preserve [--all-sdcard]
 *          Zieht rein lesend den WhatsApp-Ordner (oder mit --all-sdcard den
 *          ganzen öffentlichen Speicher), schreibt Protokoll + SHA-256-Manifest.
 *          Verändert am Gerät nichts. Kein bit-genaues Voll-Image (nicht möglich
 *          ohne Root/Forensik-Werkzeug), sondern logische Kopie + Nachweis.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const decrypt = require('./usb-decrypt');
const { pullContactsDatabase, loadContacts, mergeContacts, linkLids, contactInfo, makeNamer } = require('./usb-contacts');
const wal = require('./usb-wal');
const out = require('./backup.js'); // Ausgabe-Funktionen wiederverwenden

// ---------------------------------------------------------------- Konfiguration

const BACKUP_ROOT = process.env.WHATSAPP_BACKUP_DIR || path.join(__dirname, 'backup');
const WORK_ROOT = path.join(os.tmpdir(), 'wa-usb-' + Date.now());
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (f) => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : null; };

const USE_ROOT = hasFlag('--root');
const NO_MEDIA = hasFlag('--no-media');
const PRESERVE = hasFlag('--preserve');   // rein lesende Zustandssicherung
const ALL_SDCARD = hasFlag('--all-sdcard'); // im Preserve-Modus ganzen /sdcard ziehen
const MSG_LIMIT = Math.max(0, parseInt(argVal('--limit') || '0', 10) || 0);

// Stichtag: nur Nachrichten AB diesem Zeitpunkt sichern (Anordnungszeitpunkt).
// Eingabe JJJJ-MM-TT oder JJJJ-MM-TT HH:MM. In Millisekunden (WhatsApp-Zeitbasis).
function parseSinceMs(str) {
    if (!str) return 0;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(str).trim());
    if (!m) return 0;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return isNaN(d.getTime()) ? 0 : d.getTime();
}
const SINCE_MS = parseSinceMs(argVal('--seit') || argVal('--since'));

// Mögliche Speicherorte auf dem Handy (neuere Android-Versionen zuerst).
const DB_DIRS = [
    '/sdcard/Android/media/com.whatsapp/WhatsApp/Databases',
    '/sdcard/WhatsApp/Databases'
];
const MEDIA_DIRS = [
    '/sdcard/Android/media/com.whatsapp/WhatsApp/Media',
    '/sdcard/WhatsApp/Media'
];

function fail(msg) { console.error('\nFEHLER: ' + msg); process.exit(1); }
function log(msg) { console.log(msg); }

// ---------------------------------------------------------------- ADB-Helfer

function adb(args, opts = {}) {
    return execFileSync('adb', args, { encoding: 'buffer', maxBuffer: 1 << 30, ...opts });
}
function adbText(args) { return adb(args).toString('utf8').trim(); }

// Befehl als root ausführen. Der GANZE Befehl muss als ein String in "su -c '...'"
// stehen: adb shell fügt Argumente zu einer Zeile zusammen, sonst würden && und |
// von der normalen Shell (uid 2000) ausgeführt. exec-out statt shell, damit
// Binärdaten (Schlüssel, Datenbanken) unverfälscht ankommen.
function suExec(cmd) {
    if (cmd.includes("'")) throw new Error('suExec: einfache Anführungszeichen nicht erlaubt');
    const r = spawnSync('adb', ['exec-out', `su -c '${cmd}'`], { encoding: 'buffer', maxBuffer: 1 << 30, timeout: 120000 });
    return { ok: !r.error && r.status === 0, stdout: r.stdout || Buffer.alloc(0) };
}
// Datei per root binär auf den PC kopieren; true bei Erfolg.
function suPull(remote, local, minBytes = 1) {
    const r = suExec(`test -f ${remote} && cat ${remote}`);
    if (!r.ok || r.stdout.length < minBytes) return false;
    fs.writeFileSync(local, r.stdout);
    return true;
}

// Minimaler tar-Leser (ustar): liefert [{ name, data, mtime, mode, uid, gid }].
// mtime/Rechte/Eigentümer stammen vom Handy und werden im WAL-Bericht dokumentiert.
function untar(buf) {
    const files = [];
    for (let off = 0; off + 512 <= buf.length;) {
        const hdr = buf.subarray(off, off + 512);
        if (hdr.every((b) => b === 0)) break;
        const name = hdr.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const size = parseInt(hdr.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
        const type = String.fromCharCode(hdr[156] || 48);
        const oct = (a, b) => parseInt(hdr.subarray(a, b).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
        off += 512;
        if (type === '0') files.push({
            name: path.posix.basename(name), data: buf.subarray(off, off + size),
            mtime: new Date(oct(136, 148) * 1000), mode: oct(100, 108).toString(8), uid: oct(108, 116), gid: oct(116, 124)
        });
        off += Math.ceil(size / 512) * 512;
    }
    return files;
}

// Aktuelle Datenbank direkt aus dem App-Speicher lesen (Root). Datei, Write-
// Ahead-Log und -shm kommen in EINEM tar-Strom, damit der Stand zusammenpasst.
// Die Rohdateien bleiben unverändert erhalten (für rohdaten/ und den WAL-Bericht);
// in einer Arbeitskopie wird das Log eingearbeitet und geprüft, bei Fehler bis zu
// 3 Versuche. Am Handy wird nichts verändert.
// Liefert { path, rawDir, files } oder null.
const LIVE_DB_DIR = '/data/data/com.whatsapp/databases';
function pullLiveDatabase(name) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const rawDir = path.join(WORK_ROOT, 'roh', name + '-' + attempt);
        const dir = path.join(WORK_ROOT, 'live', name + '-' + attempt);
        fs.mkdirSync(rawDir, { recursive: true });
        fs.mkdirSync(dir, { recursive: true });
        const extra = [name + '-wal', name + '-shm'].map((f) => `$(test -f ${f} && echo ${f})`).join(' ');
        const r = suExec(`cd ${LIVE_DB_DIR} && test -f ${name} && tar -cf - ${name} ${extra}`);
        const tarFiles = r.ok ? untar(r.stdout) : [];
        const main = tarFiles.find((f) => f.name === name);
        if (!main || main.data.length < 1024) return null;
        const files = tarFiles.map((f) => {
            fs.writeFileSync(path.join(rawDir, f.name), f.data);
            // -shm nur dokumentieren: eine fremde Index-Datei nicht mit öffnen.
            if (!f.name.endsWith('-shm')) fs.writeFileSync(path.join(dir, f.name), f.data);
            return { name: f.name, bytes: f.data.length, sha256: crypto.createHash('sha256').update(f.data).digest('hex'),
                mtime: f.mtime.toLocaleString('de-DE'), mtimeIso: f.mtime.toISOString(), mode: f.mode, uid: f.uid, gid: f.gid };
        });
        const local = path.join(dir, name);
        try {
            const db = new DatabaseSync(local);
            db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            const ok = db.prepare('PRAGMA quick_check').all();
            db.close();
            if (ok.length === 1 && ok[0].quick_check === 'ok') return { path: local, rawDir, files };
        } catch (e) { /* unten erneut versuchen */ }
        log(`Kopie von ${name} uneinheitlich (App schrieb gerade) - Versuch ${attempt + 1} ...`);
    }
    return null;
}

function checkAdb() {
    let r;
    try { r = spawnSync('adb', ['version'], { encoding: 'utf8' }); }
    catch (e) { r = { error: e }; }
    if (r.error) fail('adb wurde nicht gefunden. Android Platform-Tools installieren\n'
        + 'und in den PATH legen: https://developer.android.com/tools/releases/platform-tools');
    const devices = adbText(['devices']).split('\n').slice(1)
        .map((l) => l.trim()).filter(Boolean);
    const ready = devices.filter((l) => l.endsWith('\tdevice')).map((l) => l.split('\t')[0]);
    const unauth = devices.filter((l) => l.endsWith('\tunauthorized'));
    if (unauth.length) fail('Gerät ist nicht autorisiert. Am Handy die USB-Debugging-Anfrage bestätigen.');
    if (!ready.length) fail('Kein Gerät verbunden. USB-Kabel prüfen, Handy entsperren, USB-Debugging aktivieren.');
    log(`Gerät verbunden: ${ready[0]}`);
}

// Erste existierende Datei/Verzeichnis aus einer Kandidatenliste finden.
function remoteExists(remotePath) {
    const r = spawnSync('adb', ['shell', `[ -e "${remotePath}" ] && echo yes || echo no`], { encoding: 'utf8' });
    return (r.stdout || '').trim() === 'yes';
}
function findRemote(candidates) {
    for (const c of candidates) if (remoteExists(c)) return c;
    return null;
}

// ---------------------------------------------------------------- Schlüssel

// Normalisiert eine Schlüsseleingabe zu 64 Hex-Zeichen (Leerzeichen/Zeilen egal).
function normalizeKey(raw) {
    const hex = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function ask(rl, frage) { return new Promise((r) => rl.question(frage, r)); }

// Liest den aktuell angezeigten Bildschirm per uiautomator aus und sucht darin
// den 64-stelligen Schlüssel. Setzt voraus, dass der Schlüssel-Screen offen ist.
function readKeyViaUi() {
    try {
        execFileSync('adb', ['shell', 'uiautomator', 'dump', '/sdcard/wa_ui.xml'], { stdio: 'ignore' });
        const xml = adb(['shell', 'cat', '/sdcard/wa_ui.xml']).toString('utf8');
        spawnSync('adb', ['shell', 'rm', '-f', '/sdcard/wa_ui.xml']);
        return extractKeyFromUiXml(xml);
    } catch (e) { return null; }
}

function xmlUnescape(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Extrahiert den 64-Hex-Schlüssel aus einem uiautomator-XML-Dump.
function extractKeyFromUiXml(xml) {
    const texts = [];
    const re = /text="([^"]*)"/g;
    let m;
    while ((m = re.exec(xml))) { const t = xmlUnescape(m[1]).trim(); if (t) texts.push(t); }
    // 1) Ein einzelner Knoten enthält bereits die 64 Hex-Zeichen.
    for (const t of texts) { const k = normalizeKey(t); if (k) return k; }
    // 2) Der Schlüssel ist in Gruppen aufgeteilt: hex-artige Knoten zusammensetzen.
    const hexish = texts.filter((t) => /^[0-9a-fA-F][0-9a-fA-F ]*$/.test(t) && /[0-9a-fA-F]/.test(t));
    const joined = hexish.join('').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    const run = joined.match(/[0-9a-f]{64}/);
    return run ? run[0] : null;
}

// Interaktive Schlüsselbeschaffung: vom Bildschirm lesen (uiautomator) oder eingeben.
async function acquireKeyInteractive() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        console.log('\nSchlüssel für die Entschlüsselung nötig (E2E-Backup-Schlüssel).');
        console.log('Am Handy öffnen: WhatsApp > Einstellungen > Chats > Backup >');
        console.log('  E2E-verschlüsseltes Backup > Schlüssel anzeigen.');
        while (true) {
            const a = (await ask(rl,
                '\n[Enter] = Schlüssel vom Handy-Bildschirm ablesen, oder Schlüssel einfügen: ')).trim();
            if (a) {
                const k = normalizeKey(a);
                if (k) return k;
                console.log('Das sind keine 64 gültigen Hex-Zeichen. Nochmal.');
                continue;
            }
            // Vom Bildschirm lesen
            const k = readKeyViaUi();
            if (!k) {
                console.log('Kein Schlüssel auf dem Bildschirm erkannt.');
                console.log('  - Ist der Schlüssel-Screen offen und sichtbar?');
                console.log('  - Möglich: der Screen ist gegen Auslesen geschützt (FLAG_SECURE).');
                console.log('  In dem Fall den Schlüssel bitte von Hand einfügen.');
                continue;
            }
            const grouped = k.replace(/(.{4})/g, '$1 ').trim();
            const ok = (await ask(rl, `\nVom Bildschirm gelesen:\n  ${grouped}\nStimmt das? [J/n]: `)).trim().toLowerCase();
            if (ok === '' || ok === 'j' || ok === 'y') return k;
        }
    } finally {
        rl.close();
    }
}

// Schlüsseldatei per Root auf den PC kopieren; liefert den lokalen Pfad.
// Die Datei selbst (nicht nur die letzten 32 Byte) wird an wa-crypt-tools
// übergeben - nur so gelingt crypt14 (am echten Gerät geprüft, 24.09.2026).
function readKeyViaRoot(cryptVersion) {
    log('Lese lokalen Schlüssel per Root ...');
    const probe = suExec('id').stdout.toString('utf8');
    if (!/uid=0\(/.test(probe)) {
        log('Root-Zugriff verweigert. Am Handy die Magisk/SU-Anfrage für "Shell" erlauben.');
        return null;
    }
    // crypt15 = E2E-Backup -> encrypted_backup.key; crypt14 -> key.
    const names = cryptVersion === '15' ? ['encrypted_backup.key', 'key'] : ['key'];
    const bases = ['/data/data/com.whatsapp/files', '/data/user/0/com.whatsapp/files'];
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    for (const name of names) {
        for (const base of bases) {
            const local = path.join(WORK_ROOT, 'schluessel-' + name);
            if (suPull(`${base}/${name}`, local, 32)) {
                log(`Schlüsseldatei gelesen: ${base}/${name}`);
                return local;
            }
        }
    }
    log('Keine Schlüsseldatei unter /data/data/com.whatsapp/files gefunden.');
    return null;
}

// ---------------------------------------------------------------- Pull

function pullDatabase() {
    log('\nSuche WhatsApp-Datenbank auf dem Handy ...');
    const override = argVal('--db');
    let remoteDb;
    if (override) {
        remoteDb = override;
        if (!remoteExists(remoteDb)) fail(`Angegebene Datei nicht gefunden: ${remoteDb}`);
    } else {
        const dir = findRemote(DB_DIRS);
        if (!dir) fail('Kein WhatsApp-Datenbankordner gefunden. Liegt WhatsApp auf diesem Gerät?');
        // Neueste msgstore-Datei bevorzugen (crypt15 vor crypt14).
        const listing = adbText(['shell', `ls -1 ${dir}`]).split('\n').map((s) => s.trim());
        const pick = listing.find((f) => f === 'msgstore.db.crypt15')
            || listing.find((f) => /^msgstore\.db\.crypt15$/.test(f))
            || listing.find((f) => /^msgstore\.db\.crypt14$/.test(f))
            || listing.filter((f) => /^msgstore.*\.crypt1[45]$/.test(f)).sort().pop();
        if (!pick) fail(`Keine msgstore.db.crypt14/15 in ${dir} gefunden.`);
        remoteDb = `${dir}/${pick}`;
    }
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    const localEnc = path.join(WORK_ROOT, path.basename(remoteDb));
    const cryptVersion = (/\.crypt(\d+)$/.exec(remoteDb) || [])[1] || '?';
    log(`Ziehe ${remoteDb} ...`);
    adb(['pull', remoteDb, localEnc], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (!fs.existsSync(localEnc)) fail('Datenbank konnte nicht gezogen werden.');

    return { localEnc, cryptVersion, remoteDb };
}

// Prüft die Schlüssel-Lage. crypt15 = E2E-Backup an → 64-Hex-Schlüssel reicht.
// crypt14/älter = E2E aus → nur mit lokaler Schlüsseldatei (Root) entschlüsselbar.
function guardCryptVersion(cryptVersion) {
    if (cryptVersion === '15' || USE_ROOT) return;
    console.log('\n────────────────────────────────────────────────────────────');
    console.log(`Gefunden wurde eine .crypt${cryptVersion}-Datenbank (kein E2E-Backup aktiv).`);
    console.log('Diese ist mit der lokalen Schlüsseldatei verschlüsselt, die ohne');
    console.log('Root nicht auslesbar ist. Der 64-Zeichen-Schlüssel-Screen der App');
    console.log('existiert nur bei aktivem E2E-Backup und passt hier NICHT.');
    console.log('');
    console.log('Zwei Auswege:');
    console.log('  A) E2E-verschlüsseltes Backup in WhatsApp aktivieren');
    console.log('     (Einstellungen > Chats > Backup > E2E-verschlüsseltes Backup),');
    console.log('     dann "Jetzt sichern" antippen. Es entsteht eine .crypt15,');
    console.log('     danach dieses Skript erneut starten - ohne Root.');
    console.log('  B) Auf einem gerooteten Handy mit  --root  starten.');
    console.log('────────────────────────────────────────────────────────────');
    fail(`Ohne Root und ohne E2E-Backup ist diese .crypt${cryptVersion} nicht entschlüsselbar.`);
}

function pullMedia() {
    if (NO_MEDIA) { log('Medien werden übersprungen (--no-media).'); return null; }
    const dir = findRemote(MEDIA_DIRS);
    if (!dir) { log('Kein Media-Ordner gefunden - fahre ohne Medien fort.'); return null; }
    const localMedia = path.join(WORK_ROOT, 'Media');
    fs.mkdirSync(localMedia, { recursive: true });
    log(`\nZiehe Medien aus ${dir} (kann dauern) ...`);
    try {
        adb(['pull', dir + '/.', localMedia], { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch (e) {
        log('Warnung: Medien konnten nicht vollständig gezogen werden.');
    }
    return localMedia;
}

// ---------------------------------------------------------------- Entschlüsselung

// ---------------------------------------------------------------- SQLite -> Export

function fmtDate(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function tableExists(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function sanitizeName(name) {
    return (String(name || 'unbenannt')).replace(/[<>:"/\\|?* -]/g, '_').replace(/[.\s]+$/g, '').slice(0, 80).trim() || 'unbenannt';
}

// Nachrichtentyp (Integer aus DB) + Medieninfo -> unser Typ-String.
function mapType(typeInt, mime) {
    if (mime) {
        if (mime.startsWith('image/')) return 'image';
        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('audio/')) return typeInt === 2 ? 'ptt' : 'audio';
        return 'document';
    }
    switch (typeInt) {
        case 0: return 'chat';
        case 1: return 'image';
        case 2: return 'ptt';
        case 3: return 'video';
        case 4: return 'vcard';
        case 5: return 'location';
        case 9: return 'document';
        case 13: return 'video';   // gif
        case 15: return 'sticker';
        case 7: return 'gp2';       // System/Gruppe (best effort)
        default: return 'chat';
    }
}

// Liest alle Chats + Nachrichten aus der entschlüsselten msgstore.db (modernes
// Schema: message/chat/jid/message_media). Baut Datensätze im backup.js-Format.
// opts.walIds: { neu:Set, geaendert:Set } - Nachrichten, deren Stand aus dem WAL kommt.
// Liest zu einer Systemnachricht (message_type 7) Art und Zusatzdaten aus den
// message_system*-Tabellen. Fehlende Tabellen sind erlaubt (ältere Versionen).
function systemEventReader(db) {
    const q = (table, sql) => (tableExists(db, table) ? db.prepare(sql) : null);
    const action = q('message_system', 'SELECT action_type AS a FROM message_system WHERE message_row_id = ?');
    const parts = q('message_system_chat_participant', `SELECT j.raw_string AS r FROM message_system_chat_participant p
        JOIN jid j ON j._id = p.user_jid_row_id WHERE p.message_row_id = ?`);
    const group = q('message_system_group', 'SELECT is_me_joined AS j FROM message_system_group WHERE message_row_id = ?');
    const privacy = q('message_system_initial_privacy_provider', 'SELECT privacy_provider AS p FROM message_system_initial_privacy_provider WHERE message_row_id = ?');
    const number = q('message_system_number_change', `SELECT o.raw_string AS alt, n.raw_string AS neu FROM message_system_number_change c
        LEFT JOIN jid o ON o._id = c.old_jid_row_id LEFT JOIN jid n ON n._id = c.new_jid_row_id WHERE c.message_row_id = ?`);
    const value = q('message_system_value_change', 'SELECT old_data AS v FROM message_system_value_change WHERE message_row_id = ?');
    return (mid) => {
        const a = action && action.get(mid);
        const g = group && group.get(mid);
        const p = privacy && privacy.get(mid);
        const n = number && number.get(mid);
        const v = value && value.get(mid);
        return {
            code: a ? a.a : null,
            members: parts ? parts.all(mid).map((r) => r.r) : [],
            isMeJoined: !!(g && g.j),
            privacyProvider: p ? p.p : null,
            oldNumber: n && n.alt, newNumber: n && n.neu,
            oldValue: v && typeof v.v === 'string' ? v.v : null
        };
    };
}

// Systemnachricht -> Text. Codes nach WhatsApp-Chat-Exporter (determine_metadata,
// github.com/KnugiHK/WhatsApp-Chat-Exporter) und am echten Gerät geprüft (09/2026).
// Unbelegte Codes werden NICHT geraten, sondern mit ihrer Nummer ausgegeben.
// Ergebnis ist mit backup.js groupEventText kompatibel (text/icon überschreiben).
function describeSystemEvent(ev) {
    const actor = ev.fromMe ? 'Du' : (ev.actor || 'Jemand');
    const hat = ev.fromMe ? 'hast' : 'hat';
    const list = (a) => {
        const x = (a || []).filter(Boolean);
        return x.length <= 1 ? (x[0] || 'jemanden') : `${x.slice(0, -1).join(', ')} und ${x[x.length - 1]}`;
    };
    const members = list(ev.members);
    const quote = (s) => (s ? ` „${s}“` : '');
    const out = (subtype, text, icon = '👥') => ({ subtype, code: ev.code, text, icon, actor: ev.actor || '', members: ev.members || [] });
    if (ev.isMeJoined && [4, 12, 20].includes(ev.code)) return out('add', `${actor} ${hat} dich hinzugefügt`);
    switch (ev.code) {
        case 1: return out('subject', `${actor} ${hat} den Gruppennamen in${quote(ev.text)} geändert`);
        case 4: case 12: return out('add', `${actor} ${hat} ${members} hinzugefügt`);
        case 5: case 13: return out('leave', ev.members.length ? `${members} ${ev.members.length > 1 ? 'haben' : 'hat'} die Gruppe verlassen` : `${actor} ${hat} die Gruppe verlassen`);
        case 6: return out('picture', `${actor} ${hat} das Gruppenbild geändert`);
        case 7: case 14: return out('remove', `${actor} ${hat} ${members} entfernt`);
        case 9: return out('broadcast', `${actor} ${hat} eine Broadcast-Liste erstellt`, '📢');
        case 10: case 28: {
            const nr = (j) => (j ? '+' + String(j).split('@')[0] : '');
            const wechsel = ev.oldNumber || ev.newNumber ? ` (${nr(ev.oldNumber) || '?'} → ${nr(ev.newNumber) || '?'})` : '';
            return out('number', `${actor} ${hat} die Telefonnummer gewechselt${wechsel}`, '📱');
        }
        case 11: return out('create', `${actor} ${hat} die Gruppe${quote(ev.text)} erstellt`);
        case 15: return out('promote', `${members} ${ev.members.length > 1 ? 'sind' : 'ist'} jetzt Admin`);
        case 18: case 57: return out('security', `Die Sicherheitsnummer mit ${ev.chatName || 'diesem Kontakt'} hat sich geändert`, '🔐');
        case 19: return out('e2e', 'Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt', '🔒');
        case 20: return out('invite', `${members} ${ev.members.length > 1 ? 'sind' : 'ist'} über den Einladungslink beigetreten`);
        case 27: return out('description', `${actor} ${hat} die Gruppenbeschreibung geändert`);
        case 56: return out('ephemeral', 'Einstellung für selbstlöschende Nachrichten geändert', '⏱️');
        case 58: return out('block', 'Kontakt blockiert oder Blockierung aufgehoben', '🚫');
        case 67:
            // Anfangshinweis jedes Chats; Anbieter 0 = WhatsApp-Ende-zu-Ende-Verschlüsselung.
            return ev.privacyProvider === 0 || ev.privacyProvider === null
                ? out('e2e', 'Nachrichten und Anrufe sind Ende-zu-Ende-verschlüsselt', '🔒')
                : out('privacy', `Datenschutzhinweis zu diesem Chat (Anbieter-Code ${ev.privacyProvider})`, '🔒');
        default: {
            const betrifft = ev.members.length ? ` – betrifft: ${members}` : '';
            return out(ev.code === null ? 'unbekannt' : 'code-' + ev.code,
                `Systemereignis (WhatsApp-Code ${ev.code === null ? 'unbekannt' : ev.code})${betrifft}`, 'ℹ️');
        }
    }
}

function parseDatabase(dbPath, contacts, mediaRoot, outputDir, opts = {}) {
    const walIds = opts.walIds || { neu: new Set(), geaendert: new Set() };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    if (!tableExists(db, 'message') || !tableExists(db, 'chat') || !tableExists(db, 'jid')) {
        db.close();
        fail('Unerwartetes Datenbankschema (kein message/chat/jid). Vermutlich eine sehr alte oder neue WhatsApp-Version.');
    }
    const nameFor = makeNamer(contacts);
    const hasMedia = tableExists(db, 'message_media');
    const hasCalls = tableExists(db, 'call_log');

    const chats = db.prepare(`
        SELECT c._id AS cid, j.raw_string AS jid, c.subject AS subject
        FROM chat c JOIN jid j ON c.jid_row_id = j._id
    `).all();

    // Stichtag: nur Nachrichten ab dem Anordnungszeitpunkt (m.timestamp in ms).
    const sinceClause = SINCE_MS ? 'AND m.timestamp >= ' + SINCE_MS : '';
    const msgStmt = db.prepare(`
        SELECT m._id AS mid, m.from_me AS from_me, m.timestamp AS ts,
               m.message_type AS mtype, m.text_data AS text,
               sj.raw_string AS sender
        FROM message m
        LEFT JOIN jid sj ON m.sender_jid_row_id = sj._id
        WHERE m.chat_row_id = ? ${sinceClause}
        ORDER BY m.timestamp ASC
        ${MSG_LIMIT ? 'LIMIT ' + MSG_LIMIT : ''}
    `);
    const mediaStmt = hasMedia ? db.prepare(
        'SELECT file_path, mime_type FROM message_media WHERE message_row_id = ?') : null;
    const sys = systemEventReader(db);
    // Eigene Konto-IDs: Absender eigener Nachrichten (in Gruppen die eigene @lid).
    const ownJids = new Set(db.prepare(`SELECT DISTINCT j.raw_string AS r FROM message m
        JOIN jid j ON j._id = m.sender_jid_row_id WHERE m.from_me = 1`).all().map((r) => r.r));

    const usedDirs = new Set();
    const entries = [];
    let totalMsg = 0, totalMedia = 0;

    for (const c of chats) {
        const isGroup = /@g\.us$/.test(c.jid || '');
        const chatName = c.subject || nameFor(c.jid);
        // Adressbuchname, WhatsApp-Profilname und Nummer für Übersicht/Chatkopf.
        const contact = isGroup || c.jid === '0@s.whatsapp.net' ? null : contactInfo(contacts, c.jid);
        const rows = msgStmt.all(c.cid);
        if (!rows.length) continue;

        let dirName = sanitizeName(chatName);
        if (usedDirs.has(dirName.toLowerCase())) dirName += '_' + sanitizeName((c.jid || '').split('@')[0]);
        usedDirs.add(dirName.toLowerCase());
        const chatDir = path.join(outputDir, dirName);
        const mediaDir = path.join(chatDir, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });

        const records = [];
        let mediaCount = 0;
        for (const m of rows) {
            const media = mediaStmt ? mediaStmt.get(m.mid) : null;
            const mime = media && media.mime_type || null;
            const type = mapType(m.mtype, mime);
            const senderJid = m.from_me ? null : (m.sender || c.jid);
            const rec = {
                id: 'db_' + m.mid,
                timestamp: m.ts ? Math.floor(m.ts / 1000) : 0,
                date: fmtDate(m.ts ? m.ts / 1000 : 0),
                fromMe: !!m.from_me,
                senderId: senderJid,
                senderName: m.from_me ? 'Ich' : nameFor(senderJid),
                type,
                body: m.text || '',
                hasMedia: !!media,
                mediaFile: null,
                mediaMimetype: mime
            };
            if (walIds.neu.has(m.mid)) rec.walHerkunft = 'neu';
            else if (walIds.geaendert.has(m.mid)) rec.walHerkunft = 'geändert';
            if (type === 'vcard') rec.contacts = [];
            if (type === 'gp2') {
                // Systemnachricht: Art und Beteiligte aus message_system* dekodieren.
                const ev = sys(m.mid);
                const who = (jid) => (ownJids.has(jid) ? '' : nameFor(jid));
                rec.group = describeSystemEvent({
                    ...ev, fromMe: !!m.from_me, text: m.text || '', chatName,
                    actor: m.from_me ? '' : who(m.sender),
                    members: ev.members.map((jid) => (ownJids.has(jid) ? 'dich' : nameFor(jid)))
                });
            }
            // Mediendatei aus dem gezogenen Media-Ordner in den Chat kopieren.
            if (media && media.file_path && mediaRoot) {
                const copied = copyMedia(media.file_path, mediaRoot, mediaDir, m);
                if (copied) { rec.mediaFile = copied; mediaCount++; }
            }
            records.push(rec);
        }

        // Anrufe dieses Chats ergänzen (best effort).
        if (hasCalls) {
            try {
                const calls = db.prepare(`
                    SELECT cl.timestamp AS ts, cl.from_me AS from_me,
                           cl.video_call AS video, cl.duration AS duration, cl.call_result AS result
                    FROM call_log cl JOIN jid j ON cl.jid_row_id = j._id
                    WHERE j.raw_string = ? ${SINCE_MS ? 'AND cl.timestamp >= ' + SINCE_MS : ''}`).all(c.jid || '');
                for (const cl of calls) {
                    records.push({
                        id: 'call_' + cl.ts, timestamp: Math.floor((cl.ts || 0) / 1000),
                        date: fmtDate((cl.ts || 0) / 1000), fromMe: !!cl.from_me,
                        senderId: c.jid, senderName: cl.from_me ? 'Ich' : nameFor(c.jid),
                        type: 'call_log', body: '', hasMedia: false, mediaFile: null, mediaMimetype: null,
                        call: { video: !!cl.video, duration: cl.duration || 0, missed: !(cl.duration > 0) && !cl.from_me }
                    });
                }
            } catch (e) { /* Schema abweichend - überspringen */ }
        }

        records.sort((a, b) => a.timestamp - b.timestamp);
        fs.writeFileSync(path.join(chatDir, 'messages.json'), JSON.stringify(
            { chatName, chatId: c.jid, isGroup, contact, exportedAt: new Date().toISOString(), messages: records }, null, 2));
        out.writeChatHtml(chatDir, chatName, records, isGroup, dirName, contact);

        entries.push({ dir: dirName, name: chatName, isGroup, contact, messages: records.length, media: mediaCount, records });
        totalMsg += records.length; totalMedia += mediaCount;
    }
    db.close();
    return { entries, totalMsg, totalMedia };
}

// Sucht die Mediendatei (DB-Pfad ist relativ zum WhatsApp-Ordner) im gezogenen
// Media-Ordner und kopiert sie mit Datums-/ID-Namen in den Chat-media-Ordner.
function copyMedia(filePath, mediaRoot, mediaDir, m) {
    // filePath z. B. "Media/WhatsApp Images/IMG-2026...jpg" -> relativ zu Media/..
    let rel = filePath.replace(/^.*Media\//, '');
    const src = path.join(mediaRoot, rel);
    if (!fs.existsSync(src)) return null;
    const ext = path.extname(src) || '';
    const base = `${new Date((m.ts || 0)).toISOString().slice(0, 10)}_${m.mid}${ext}`;
    try { fs.copyFileSync(src, path.join(mediaDir, base)); return base; }
    catch (e) { return null; }
}

// ---------------------------------------------------------------- Preserve

// Liest Geräte-Eckdaten über getprop aus (best effort).
function getDeviceInfo() {
    const prop = (k) => { try { return adbText(['shell', 'getprop', k]) || null; } catch (e) { return null; } };
    let waVersion = null;
    try {
        const dump = adbText(['shell', 'dumpsys', 'package', 'com.whatsapp']);
        const m = /versionName=(\S+)/.exec(dump);
        if (m) waVersion = m[1];
    } catch (e) { /* dumpsys evtl. eingeschränkt */ }
    return {
        serial: prop('ro.serialno'),
        hersteller: prop('ro.product.manufacturer'),
        modell: prop('ro.product.model'),
        android: prop('ro.build.version.release'),
        sdk: prop('ro.build.version.sdk'),
        build: prop('ro.build.display.id'),
        whatsapp: waVersion
    };
}

// Baut den Protokolltext der lesenden Sicherung (reine Zeichenkette -> testbar).
function buildPreserveProtocol(info) {
    const z = (v) => (v === null || v === undefined || v === '') ? '(unbekannt)' : String(v);
    return [
        'PROTOKOLL - Lesende Zustandssicherung (WhatsApp)',
        '='.repeat(56),
        '',
        `Erstellt am:        ${info.erstellt}`,
        `Werkzeug:           usb-backup.js --preserve  (rein lesend)`,
        `adb-Version:        ${z(info.adbVersion)}`,
        '',
        'Gerät',
        '-----',
        `Serial:             ${z(info.serial)}`,
        `Hersteller/Modell:  ${z(info.hersteller)} ${z(info.modell)}`,
        `Android-Version:    ${z(info.android)} (SDK ${z(info.sdk)})`,
        `Build:              ${z(info.build)}`,
        `WhatsApp-Version:   ${z(info.whatsapp)}`,
        '',
        'Gesicherte Quelle(n) auf dem Handy',
        '----------------------------------',
        ...info.quellen.map((q) => `  ${q}`),
        '',
        'Umfang',
        '------',
        `Dateien:            ${info.dateien}`,
        `Gesamtgröße:        ${(info.bytes / 1048576).toFixed(1)} MB`,
        '',
        'Hinweise',
        '--------',
        '- Der Zugriff erfolgte ausschließlich lesend (adb pull). Am Gerät',
        '  wurde nichts verändert; Einstellungen und Daten sind unangetastet.',
        '- Es handelt sich NICHT um ein bit-genaues Voll-Image, sondern um eine',
        '  logische Kopie des öffentlichen Speichers (App-Sandbox und interne',
        '  Partitionen sind ohne Root/Forensik-Werkzeug nicht zugänglich).',
        '- Die SHA-256-Prüfsummen aller kopierten Dateien stehen in',
        '  manifest.json; deren Unversehrtheit sichert manifest.sha256.',
        '  Prüfen: Backup-pruefen.bat  bzw.  node backup.js --pruefen <ordner>',
        ''
    ].join('\n');
}

// Zählt Dateien und Gesamtgröße unterhalb eines Ordners.
function countTree(dir) {
    let files = 0, bytes = 0;
    if (!fs.existsSync(dir)) return { files, bytes };
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const s = countTree(p); files += s.files; bytes += s.bytes; }
        else { files++; bytes += fs.statSync(p).size; }
    }
    return { files, bytes };
}

async function runPreserve() {
    log('Lesende Zustandssicherung (WhatsApp)\n════════════════════════════════════');
    log('Rein lesend - am Handy wird nichts verändert.\n');
    checkAdb();

    // Quelle(n) bestimmen.
    const sources = [];
    if (ALL_SDCARD) {
        sources.push('/sdcard');
    } else {
        const waBase = ['/sdcard/Android/media/com.whatsapp/WhatsApp', '/sdcard/WhatsApp']
            .find((p) => remoteExists(p));
        if (!waBase) fail('Kein WhatsApp-Ordner im öffentlichen Speicher gefunden.');
        sources.push(waBase);
    }

    const stamp = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; })();
    const outputDir = path.join(BACKUP_ROOT, `PRESERVE_${stamp}`);
    const dataDir = path.join(outputDir, 'daten');
    fs.mkdirSync(dataDir, { recursive: true });

    log('Lese Geräte-Eckdaten ...');
    const info = getDeviceInfo();

    for (const src of sources) {
        log(`Ziehe ${src} (rein lesend, kann dauern) ...`);
        try {
            adb(['pull', src, dataDir], { stdio: ['ignore', 'ignore', 'inherit'] });
        } catch (e) {
            log(`Warnung: ${src} konnte nicht vollständig gezogen werden.`);
        }
    }

    const { files, bytes } = countTree(dataDir);
    if (!files) fail('Es wurden keine Dateien gezogen.');

    let adbVersion = null;
    try { adbVersion = (adbText(['version']).split('\n')[0] || '').trim(); } catch (e) { /* egal */ }

    const protokoll = buildPreserveProtocol({
        erstellt: new Date().toLocaleString('de-DE'),
        adbVersion, ...info, quellen: sources, dateien: files, bytes
    });
    fs.writeFileSync(path.join(outputDir, 'PROTOKOLL.txt'), protokoll);
    fs.writeFileSync(path.join(outputDir, 'preserve-info.json'), JSON.stringify(
        { erstellt: new Date().toISOString(), adbVersion, geraet: info, quellen: sources, dateien: files, bytes }, null, 2));

    log('\nBerechne SHA-256-Prüfsummen (manifest.json) ...');
    out.writeManifest(outputDir, { art: 'preserve', geraet: `${info.hersteller || ''} ${info.modell || ''}`.trim(), dateien: files });

    // Arbeitsordner nicht nötig; hier wurde direkt in den Zielordner gezogen.
    log(`\nFertig: ${files} Dateien, ${(bytes / 1048576).toFixed(1)} MB gesichert (rein lesend).`);
    log(`Liegt in: ${outputDir}`);
    log(`Protokoll: ${path.join(outputDir, 'PROTOKOLL.txt')}`);
    log('Prüfen später mit: Backup-pruefen.bat  (oder node backup.js --pruefen <ordner>)');
}

// ---------------------------------------------------------------- Ablauf

async function main() {
    if (PRESERVE) { await runPreserve(); return; }

    log('WhatsApp-Backup über USB\n════════════════════════');
    checkAdb();

    // Mit Root: IMMER die aktuelle Datenbank direkt aus der App lesen - kein
    // Schlüssel, kein Umweg über die (bis zu einen Tag alte) Sicherungsdatei.
    let dbPath = null, waDb = null, contactsDb = null, quelle, msLive = null, waLive = null;
    if (USE_ROOT) {
        log('\nLese aktuelle WhatsApp-Datenbanken direkt vom Handy (Root) ...');
        const probe = suExec('id').stdout.toString('utf8');
        if (!/uid=0\(/.test(probe)) fail('Root-Zugriff verweigert. Am Handy die Magisk/SU-Anfrage für "Shell" erlauben und neu starten.');
        msLive = pullLiveDatabase('msgstore.db');
        waLive = pullLiveDatabase('wa.db');
        dbPath = msLive && msLive.path;
        waDb = waLive && waLive.path;
        if (dbPath) {
            quelle = `aktuelle App-Datenbank ${LIVE_DB_DIR}/msgstore.db (per Root, gelesen ${new Date().toLocaleString('de-DE')})`;
            log('msgstore.db (aktueller Stand) gelesen und geprüft.');
        } else {
            log('Warnung: aktuelle msgstore.db nicht lesbar - weiche auf die Sicherungsdatei aus.');
        }
        log(waDb ? 'wa.db (Kontakte) gelesen und geprüft.' : 'Warnung: wa.db nicht lesbar - Kontaktnamen können fehlen.');
    }

    if (!dbPath) {
        const python = decrypt.requireDecryptPython();
        // DB zuerst ziehen (schnell) - so kennen wir die crypt-Version, bevor wir
        // nach einem Schlüssel fragen, den es evtl. gar nicht gibt.
        const { localEnc, cryptVersion, remoteDb } = pullDatabase();
        guardCryptVersion(cryptVersion);

        // Schlüssel besorgen: Argument > Root-Datei > Bildschirm/Eingabe.
        // key ist entweder 64-Hex oder der Pfad der per Root kopierten Schlüsseldatei.
        let key = normalizeKey(argVal('--key'));
        if (!key && USE_ROOT) key = readKeyViaRoot(cryptVersion);
        // Für crypt14 gibt es keinen Schlüssel-Screen - nicht danach fragen.
        if (!key && cryptVersion !== '15') fail(`Die .crypt${cryptVersion} braucht die Schlüsseldatei vom Handy; sie ließ sich per Root nicht lesen (siehe oben).`);
        if (!key) key = await acquireKeyInteractive();
        if (!key) fail('Kein gültiger 64-stelliger Schlüssel angegeben.');

        log('\nEntschlüssele Datenbank ...');
        dbPath = decrypt.decryptDatabase(localEnc, key, path.join(WORK_ROOT, 'msgstore.db'), python);
        log('Datenbank entschlüsselt und geprüft.');
        quelle = `Sicherungsdatei ${remoteDb} (Stand der letzten WhatsApp-Sicherung)`;
        contactsDb = pullContactsDatabase({
            remoteDb, workRoot: WORK_ROOT, key, python, rootDb: waDb,
            exists: remoteExists,
            pull: (remote, local) => adb(['pull', remote, local], { stdio: ['ignore', 'ignore', 'inherit'] }),
            log
        });
    }
    // Root-wa.db (aktuell) zuerst, Kontaktsicherung ergänzt fehlende Angaben.
    const contacts = waDb ? loadContacts(waDb) : new Map();
    if (contactsDb && contactsDb !== waDb) mergeContacts(contacts, loadContacts(contactsDb));
    linkLids(contacts, dbPath);

    // Forensische Dokumentation: was stand im Write-Ahead-Log?
    const walReports = [];
    if (msLive || waLive) {
        log('\nWerte Write-Ahead-Logs aus ...');
        const nameFor = makeNamer(contacts);
        for (const [name, l] of [['msgstore.db', msLive], ['wa.db', waLive]]) {
            if (!l) continue;
            walReports.push(wal.analyzeLive({ name, remoteDir: LIVE_DB_DIR, rawDir: l.rawDir, merged: l.path,
                files: l.files, workDir: path.join(WORK_ROOT, 'wal'), nameFor }));
        }
        log(wal.walSummary(walReports).split(' | ').join('\n'));
    }
    const walIds = wal.walMessageIds(walReports.find((r) => r.datenbank === 'msgstore.db'));
    const mediaRoot = pullMedia();

    // Zielordner anlegen.
    const stamp = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; })();
    const backupId = `USB_${stamp}`;
    const outputDir = path.join(BACKUP_ROOT, backupId);
    fs.mkdirSync(outputDir, { recursive: true });
    out.setOutputDir(outputDir);
    out.setBackupId(backupId);

    log('\nLese Chats aus der Datenbank ...');
    log(`Zeitraum: ${SINCE_MS ? 'ab ' + new Date(SINCE_MS).toLocaleString('de-DE') : 'gesamter verfügbarer Verlauf'}.`);
    const { entries, totalMsg, totalMedia } = parseDatabase(dbPath, contacts, mediaRoot, outputDir, { walIds });
    if (!entries.length) fail('Keine Chats in der Datenbank gefunden.');
    entries.sort((a, b) => a.name.localeCompare(b.name, 'de'));

    const groups = entries.filter((e) => e.isGroup).length;
    const meta = {
        backupId, konto: null, profilname: null, plattform: 'android (USB)',
        erstellt: new Date().toLocaleString('de-DE'),
        quelle,
        walHinweis: walReports.length ? wal.walSummary(walReports) + ' - Einzelheiten: wal-bericht.html, Rohdateien: rohdaten/' : null,
        zeitraum: SINCE_MS
            ? `${new Date(SINCE_MS).toLocaleString('de-DE')} bis ${new Date().toLocaleString('de-DE')}`
            : null,
        chats: entries.length, gruppen: groups, nachrichten: totalMsg, medien: totalMedia,
        waWebVersion: null
    };

    // Rohdateien unverändert beilegen (vom Manifest erfasst) + WAL-Bericht.
    if (walReports.length) {
        const rawOut = path.join(outputDir, 'rohdaten');
        fs.mkdirSync(rawOut, { recursive: true });
        for (const l of [msLive, waLive]) if (l) for (const f of l.files) fs.copyFileSync(path.join(l.rawDir, f.name), path.join(rawOut, f.name));
        wal.writeWalReport(outputDir, walReports, { backupId });
    }
    out.writeIndexHtml(entries, { walBericht: walReports.length > 0 });
    out.writeDocumentationHtml(outputDir, meta);
    out.writeEvidenceHtml(entries, meta);
    out.writeManifest(outputDir, { konto: 'USB', chats: entries.length, nachrichten: totalMsg, medien: totalMedia });

    // Arbeitskopie (entschlüsselte DB, Medien-Rohkopie) wieder entfernen.
    try { fs.rmSync(WORK_ROOT, { recursive: true, force: true }); } catch (e) { /* egal */ }

    log(`\nFertig: ${entries.length} Chats (davon ${groups} Gruppen), ${totalMsg} Nachrichten, ${totalMedia} Medien.`);
    log(`Backup liegt in: ${outputDir}`);
    log(`Übersicht öffnen: ${path.join(outputDir, 'index.html')}`);
}

if (require.main === module) {
    // Kopierte Schlüsseldatei / entschlüsselte DB nie im Temp-Ordner liegen lassen,
    // auch nicht bei Fehler oder Strg+C.
    process.on('exit', () => { try { fs.rmSync(WORK_ROOT, { recursive: true, force: true }); } catch (e) { /* egal */ } });
    process.on('SIGINT', () => process.exit(130));
    main().catch((e) => fail(e && e.stack || String(e)));
}

module.exports = { _test: { untar, describeSystemEvent, normalizeKey, mapType, parseDatabase, loadContacts, fmtDate, extractKeyFromUiXml, buildPreserveProtocol, parseSinceMs } };
