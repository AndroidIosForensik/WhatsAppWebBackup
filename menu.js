/**
 * WhatsApp-Backup - geführter Startassistent
 *
 * Ein Einstiegspunkt für alle Funktionen. Fragt, was gesichert/geprüft werden
 * soll, prüft Voraussetzungen, stellt die nötigen Rückfragen und startet dann
 * den passenden Ablauf (backup.js bzw. usb-backup.js) mit den richtigen Optionen.
 *
 * Aufruf:  node menu.js   (oder Start.bat doppelklicken)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync, execFileSync } = require('child_process');
const { detectDecryptPython } = require('./usb-decrypt');

const BACKUP_ROOT = process.env.WHATSAPP_BACKUP_DIR || path.join(__dirname, 'backup');
const NODE = process.execPath;

// ---------------------------------------------------------------- Hilfen

function line(w = 60) { return '─'.repeat(w); }

// Richtet ein zeilenbasiertes Einlesen ein (robust für Terminal UND umgeleitete
// Eingabe). Zeilen werden über das 'line'-Ereignis gepuffert; ask() entnimmt sie.
function setupInput(rl) {
    rl._q = [];
    rl._closed = false;
    rl._w = null;
    rl.on('line', (l) => {
        if (rl._w) { const w = rl._w; rl._w = null; w(l.trim()); }
        else rl._q.push(l.trim());
    });
    rl.on('close', () => { rl._closed = true; if (rl._w) { const w = rl._w; rl._w = null; w(''); } });
}

// Fragt eine Zeile ab. EOF/Strg+Z löst mit leerem String auf, statt zu hängen.
function ask(rl, frage) {
    if (frage) process.stdout.write(frage);
    if (rl._q.length) return Promise.resolve(rl._q.shift());
    if (rl._closed) return Promise.resolve('');
    return new Promise((res) => { rl._w = res; });
}

async function askYesNo(rl, frage, def = true) {
    const a = (await ask(rl, `${frage} [${def ? 'J/n' : 'j/N'}]: `)).toLowerCase();
    if (a === '') return def;
    return a === 'j' || a === 'y';
}

// Fragt ein Datum (JJJJ-MM-TT), leere Eingabe = kein Stichtag. Ungültiges wird
// erneut abgefragt.
async function askDate(rl, frage) {
    while (true) {
        const a = await ask(rl, frage);
        if (!a) return '';
        if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(a)) return a;
        console.log('  Bitte im Format JJJJ-MM-TT eingeben (z. B. 2026-06-20) oder leer lassen.');
    }
}

async function askNumber(rl, frage) {
    const a = await ask(rl, frage);
    const n = parseInt(a, 10);
    return !isNaN(n) && n > 0 ? n : 0;
}

// Prüft, ob ein Kommando aufrufbar ist.
function have(cmd, args = ['--version']) {
    try { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return !r.error && r.status === 0; }
    catch (e) { return false; }
}

// Vorhandene Backup-Ordner, neueste zuerst.
function listBackups() {
    if (!fs.existsSync(BACKUP_ROOT)) return [];
    return fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: path.join(BACKUP_ROOT, e.name), mtime: fs.statSync(path.join(BACKUP_ROOT, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------- Argument-Bau

function buildWebArgs(a) {
    const args = [];
    if (a.alle) args.push('--alle');
    if (a.limit > 0) args.push('--limit', String(a.limit));
    if (a.since) args.push('--seit', a.since);
    return args;
}
function buildUsbArgs(a) {
    const args = [];
    if (a.root) args.push('--root');
    if (a.noMedia) args.push('--no-media');
    if (a.limit > 0) args.push('--limit', String(a.limit));
    if (a.since) args.push('--seit', a.since);
    return args;
}
function buildPreserveArgs(a) {
    const args = ['--preserve'];
    if (a.allSdcard) args.push('--all-sdcard');
    return args;
}

// Startet ein Skript mit geerbter Konsole (interaktive Prompts + Browserfenster
// der Unterskripte funktionieren dadurch normal).
function run(script, args) {
    console.log(`\n> node ${script} ${args.join(' ')}\n${line()}`);
    const r = spawnSync(NODE, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
    console.log(line());
    return r.status === 0;
}

// ---------------------------------------------------------------- Abläufe

async function flowWeb(rl) {
    console.log(`\n${line()}\nWhatsApp Web sichern (QR-Code, kein Kabel)\n${line()}`);
    console.log('Es öffnet sich ein Browser mit WhatsApp Web. QR-Code scannen,');
    console.log('danach die gewünschten Chats im Auswahlfenster anklicken.\n');
    console.log('Vor dem Export lädt das Tool die Chats automatisch bis zur ältesten verfügbaren Nachricht.\n');
    const alle = !(await askYesNo(rl, 'Chats nach dem Anmelden selbst auswählen? (nein = alle sichern)', true));
    const since = await askDate(rl, 'Nur Nachrichten ab Datum? (JJJJ-MM-TT, leer = alle): ');
    const limit = await askNumber(rl, 'Höchstzahl Nachrichten pro Chat? (leer/0 = alle): ');
    run('backup.js', buildWebArgs({ alle, since, limit }));
}

async function flowUsb(rl) {
    console.log(`\n${line()}\nUSB sichern (Kabel, offline)\n${line()}`);
    console.log('Voraussetzungen: Handy per USB, entsperrt, USB-Debugging an;');
    console.log('adb im PATH; Python + wa-crypt-tools; aktiviertes E2E-Backup.\n');

    const okAdb = have('adb', ['version']);
    const okWat = !!detectDecryptPython().python;
    console.log(`  adb gefunden:            ${okAdb ? 'ja' : 'NEIN'}`);
    console.log(`  wa-crypt-tools:          ${okWat ? 'ja' : 'NEIN'}`);
    if (!okAdb) console.log('  -> Installieren: winget install Google.PlatformTools');
    if (!okWat) console.log('  -> Installieren/reparieren: python -m pip install --upgrade wa-crypt-tools');
    if (!okAdb || !okWat) {
        if (!(await askYesNo(rl, '\nTrotzdem fortfahren?', false))) return;
    }

    const root = await askYesNo(rl, '\nIst das Handy gerootet? (dann aktueller Stand direkt aus der App, ohne Schlüssel)', false);
    const since = await askDate(rl, 'Nur Nachrichten ab Datum? (JJJJ-MM-TT, leer = alle): ');
    const noMedia = !(await askYesNo(rl, 'Mediendateien (Bilder/Videos) mitsichern?', true));
    run('usb-backup.js', buildUsbArgs({ root, since, noMedia, limit: 0 }));
}

async function flowPreserve(rl) {
    console.log(`\n${line()}\nLesende Zustandssicherung (verändert nichts)\n${line()}`);
    console.log('Kopiert rein lesend den WhatsApp-Ordner vom Handy und schreibt');
    console.log('Protokoll + SHA-256-Prüfsummen. Kein Entschlüsseln, kein Schlüssel.');
    console.log('Sinnvoll, BEVOR man am Handy etwas umstellt (z. B. E2E aktiviert).\n');
    if (!have('adb', ['version'])) {
        console.log('adb nicht gefunden -> winget install Google.PlatformTools');
        if (!(await askYesNo(rl, 'Trotzdem fortfahren?', false))) return;
    }
    const allSdcard = await askYesNo(rl, 'Gesamten öffentlichen Speicher sichern? (nein = nur WhatsApp)', false);
    run('usb-backup.js', buildPreserveArgs({ allSdcard }));
}

async function flowVerify(rl) {
    console.log(`\n${line()}\nBackup-Integrität prüfen\n${line()}`);
    const backups = listBackups();
    if (!backups.length) { console.log('Keine Backups im Ordner "backup" gefunden.'); return; }
    backups.slice(0, 15).forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b.name}`));
    const a = await ask(rl, '\nNummer wählen (leer = neuestes): ');
    const idx = a ? parseInt(a, 10) - 1 : 0;
    const chosen = backups[idx];
    if (!chosen) { console.log('Ungültige Auswahl.'); return; }
    run('backup.js', ['--pruefen', chosen.path]);
}

async function flowOpen(rl) {
    console.log(`\n${line()}\nBackup öffnen (Übersicht im Browser)\n${line()}`);
    const backups = listBackups().filter((b) => fs.existsSync(path.join(b.path, 'index.html')));
    if (!backups.length) { console.log('Kein Backup mit index.html gefunden.'); return; }
    backups.slice(0, 15).forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b.name}`));
    const a = await ask(rl, '\nNummer wählen (leer = neuestes): ');
    const idx = a ? parseInt(a, 10) - 1 : 0;
    const chosen = backups[idx];
    if (!chosen) { console.log('Ungültige Auswahl.'); return; }
    const idxFile = path.join(chosen.path, 'index.html');
    try { execFileSync('cmd', ['/c', 'start', '', idxFile]); console.log('Geöffnet: ' + idxFile); }
    catch (e) { console.log('Konnte nicht öffnen. Datei: ' + idxFile); }
}

function showHelp() {
    console.log(`\n${line()}\nWas ist was?\n${line()}`);
    console.log('1) WhatsApp Web  - schnellste Variante, nur QR-Code scannen. Die Daten');
    console.log('   laufen Ende-zu-Ende-verschlüsselt über die WhatsApp-Server.');
    console.log('2) USB (offline) - zieht die Datenbank per Kabel, ganz ohne Internet.');
    console.log('   Gerootet: liest den aktuellen Stand direkt aus der App. Sonst braucht');
    console.log('   es wa-crypt-tools und ein aktiviertes E2E-Backup (Stand der letzten Sicherung).');
    console.log('3) Lesende Sicherung - bewahrt den JETZIGEN Stand rein lesend, bevor man');
    console.log('   am Handy etwas ändert. Kein Entschlüsseln.');
    console.log('4) Prüfen - rechnet die SHA-256-Prüfsummen eines Backups nach.');
    console.log('5) Öffnen - zeigt die Übersicht (Suche/Beweise) eines Backups im Browser.');
}

// ---------------------------------------------------------------- Menü

const MENU = [
    ['WhatsApp Web sichern (QR-Code, kein Kabel)', flowWeb],
    ['USB sichern (Kabel, offline, entschlüsselt)', flowUsb],
    ['Lesende Zustandssicherung (USB, verändert nichts)', flowPreserve],
    ['Backup-Integrität prüfen', flowVerify],
    ['Backup öffnen (Übersicht im Browser)', flowOpen],
    ['Was ist was? (Erklärung)', async () => showHelp()]
];

async function main() {
    const rl = readline.createInterface({ input: process.stdin });
    setupInput(rl);
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║  WhatsApp-Backup - Startassistent' + ' '.repeat(24) + '║');
    console.log('╚' + '═'.repeat(58) + '╝');
    try {
        while (true) {
            console.log('\nWas möchtest du tun?\n');
            MENU.forEach((m, i) => console.log(`  ${i + 1}) ${m[0]}`));
            console.log('  0) Beenden');
            const a = await ask(rl, '\nAuswahl: ');
            if (rl._closed && !a) break;
            if (a === '0' || a.toLowerCase() === 'q') break;
            const item = MENU[parseInt(a, 10) - 1];
            if (!item) { console.log('Ungültige Auswahl.'); continue; }
            try { await item[1](rl); }
            catch (e) { console.error('Fehler im Ablauf: ' + (e && e.message || e)); }
            await ask(rl, '\n[Enter] für zurück zum Menü ...');
        }
    } finally {
        rl.close();
    }
    console.log('Beendet.');
}

if (require.main === module) {
    main();
}

module.exports = { _test: { buildWebArgs, buildUsbArgs, buildPreserveArgs, listBackups } };
