/**
 * WhatsApp-Backup über WhatsApp Web
 *
 * Öffnet ein sichtbares Browser-Fenster mit WhatsApp Web. Bei jedem Start dort
 * per QR-Code anmelden (Handy: WhatsApp > Verknüpfte Geräte). Es wird KEINE
 * Sitzung gespeichert, damit sich jedes Mal ein beliebiges Gerät anmelden kann.
 *
 * Danach werden die Chats als JSON + HTML gespeichert und die Mediendateien
 * heruntergeladen. Jeder Lauf legt einen eigenen Ordner mit Zeitstempel an.
 *
 * Zu Beginn wird gefragt, wie viele Nachrichten pro Chat gesichert werden sollen
 * (0 = alle). Nach der Anmeldung kann man die gewünschten Chats aus einer Liste
 * auswählen (Nummern/Bereiche, Suchfilter, Enter = alle). Alternativ per Argument:
 *
 * Aufruf:  node backup.js [--chats <N>] [--alle] [--limit <N>] [--seit <Datum>] [--wait <Sek>]
 *          --chats  nicht-interaktiv: nur die ersten N (zuletzt aktiven) Chats
 *          --alle   nicht-interaktiv: alle Chats (überspringt die Auswahl)
 *          --limit  max. Nachrichten pro Chat (0/weglassen = alle)
 *          --seit   nur Nachrichten ab Datum (JJJJ-MM-TT), z. B. Anordnungszeitpunkt
 *          --wait   Wartezeit nach Login in Sekunden (Standard: 30)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// ---------------------------------------------------------------- Konfiguration

// Alle Läufe landen unter backup/; jeder Lauf bekommt darin einen eigenen
// Unterordner (Kontonummer + Zeitstempel), der erst nach dem Login feststeht.
const BACKUP_ROOT = process.env.WHATSAPP_BACKUP_DIR || path.join(__dirname, 'backup');
let OUTPUT_DIR = BACKUP_ROOT;
// Eindeutige Kennung des laufenden Backups (= Ordnername). Dient den erzeugten
// HTML-Seiten als Schlüssel, damit Beweis-Markierungen verschiedener Backups
// sich im Browser-Speicher (localStorage) nicht vermischen.
let BACKUP_ID = '';

function runTimestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function parseNumArg(flag, def) {
    const i = process.argv.indexOf(flag);
    if (i !== -1 && process.argv[i + 1]) {
        const n = parseInt(process.argv[i + 1], 10);
        if (!isNaN(n) && n >= 0) return n;
    }
    return def;
}

// "alle": Infinity geht nicht, weil das Limit per JSON in den Browser übertragen
// wird (Infinity -> null) - stattdessen eine große endliche Zahl verwenden.
const ALL = Number.MAX_SAFE_INTEGER;

// 0 bedeutet "alle". Diese Werte werden ggf. interaktiv abgefragt/ausgewählt.
let CHAT_LIMIT = parseNumArg('--chats', 0);      // erste N Chats (nicht-interaktiv)
let MESSAGE_LIMIT = parseNumArg('--limit', 0);   // Nachrichten pro Chat
const chatsArgGiven = process.argv.includes('--chats');
const limitArgGiven = process.argv.includes('--limit');
const forceAll = process.argv.includes('--alle');
// Chats interaktiv (per GUI/Konsole) auswählen? Standardfall ohne --chats/--alle.
const interactiveSelect = !chatsArgGiven && !forceAll;

// Wartezeit (Sekunden) nach dem Login, bevor gesichert wird. Nach einer frischen
// QR-Anmeldung überträgt WhatsApp die Chat-Historie erst nach und nach vom Handy;
// eine längere Wartezeit holt mehr davon ab. Über --wait <Sekunden> anpassbar.
const SYNC_WAIT_SECONDS = parseNumArg('--wait', 30);

// Stichtag: nur Nachrichten AB diesem Zeitpunkt sichern (0 = alle). Für die
// rechtlich saubere Beschränkung auf den Zeitraum ab Anordnung. Eingabe als
// Datum (JJJJ-MM-TT) oder Datum+Uhrzeit (JJJJ-MM-TT HH:MM). Rückgabe: Unix-Sek.
function parseSince(str) {
    if (!str) return 0;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(str).trim());
    if (!m) return 0;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    const t = Math.floor(d.getTime() / 1000);
    return isNaN(t) || t <= 0 ? 0 : t;
}
let SINCE_TS = parseSince(argVal('--seit') || argVal('--since'));

function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : null;
}

// Menschenlesbarer Zeitraum fürs Protokoll und die Dokumentation.
function sinceLabel(ts) {
    if (!ts) return 'gesamter verfügbarer Verlauf';
    return `ab ${new Date(ts * 1000).toLocaleString('de-DE')}`;
}

// Parst eine Auswahl-Eingabe wie "1,3,5-8" zu 0-basierten Indizes (<count).
// Rückgabe: Array von Indizes, [] bei leerer Eingabe (= "alle"), 'invalid' bei Fehler.
function parseSelection(input, count) {
    const s = String(input).trim();
    if (!s) return [];
    const set = new Set();
    for (const part of s.split(/[\s,]+/).filter(Boolean)) {
        const range = /^(\d+)-(\d+)$/.exec(part);
        if (range) {
            let a = parseInt(range[1], 10), b = parseInt(range[2], 10);
            if (a > b) { const t = a; a = b; b = t; }
            for (let i = a; i <= b; i++) if (i >= 1 && i <= count) set.add(i - 1);
        } else if (/^\d+$/.test(part)) {
            const i = parseInt(part, 10);
            if (i >= 1 && i <= count) set.add(i - 1);
        } else {
            return 'invalid';
        }
    }
    return [...set].sort((x, y) => x - y);
}

function chatDisplayName(c) {
    return c.name || (c.id && c.id.user) || '(unbenannt)';
}

function printChatList(view) {
    console.log(`\n${view.length} Chats:`);
    view.forEach((o, i) => {
        const c = o.c;
        const type = c.isGroup ? 'Gruppe' : 'Chat  ';
        console.log(`  ${String(i + 1).padStart(3)}. [${type}] ${chatDisplayName(c)}`);
    });
}

// Interaktive Chat-Auswahl auf der Konsole. Unterstützt Nummern/Bereiche,
// einen Suchfilter ("s <text>") und Enter = alle aktuell angezeigten.
async function selectChats(chats) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((r) => rl.question(q, r));
    const allView = () => chats.map((c, i) => ({ c, orig: i }));
    let view = allView();
    try {
        console.log('\n────────────────────────────────────────────────────────');
        console.log('Chat-Auswahl');
        console.log('  • Nummern/Bereiche, z. B.  1,3,5-8');
        console.log('  • "s <text>"   nach Namen filtern (z. B.  s klasse)');
        console.log('  • "s"          Filter zurücksetzen (alle anzeigen)');
        console.log('  • Enter        alle aktuell angezeigten Chats');
        console.log('────────────────────────────────────────────────────────');
        while (true) {
            printChatList(view);
            const ans = (await ask('\nAuswahl: ')).trim();
            const searchMatch = /^s(?:uche)?(?:\s+(.*))?$/i.exec(ans);
            if (searchMatch) {
                const term = (searchMatch[1] || '').trim().toLowerCase();
                view = term
                    ? allView().filter((o) => chatDisplayName(o.c).toLowerCase().includes(term))
                    : allView();
                if (!view.length) {
                    console.log('Keine Treffer – zeige wieder alle Chats.');
                    view = allView();
                }
                continue;
            }
            const sel = parseSelection(ans, view.length);
            if (sel === 'invalid') {
                console.log('Ungültige Eingabe. Bitte Nummern/Bereiche wie 1,3,5-8 eingeben.');
                continue;
            }
            const chosen = sel.length ? sel.map((i) => view[i].c) : view.map((o) => o.c);
            console.log(`\n${chosen.length} Chat(s) ausgewählt.\n`);
            return chosen;
        }
    } finally {
        rl.close();
    }
}

// -------- Grafische Chat-Auswahl (im vorhandenen Browser) --------------------

const GUI_CSS = `
*{box-sizing:border-box;}
html,body{height:100%;margin:0;}
body{font-family:Segoe UI,Arial,sans-serif;background:#f0f2f5;color:#111b21;display:flex;flex-direction:column;height:100vh;}
.top{background:#075e54;color:#fff;padding:14px 20px;box-shadow:0 2px 6px rgba(0,0,0,.2);}
.top h1{margin:0 0 10px;font-size:1.15em;}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;}
.controls input[type=search]{flex:1;min-width:180px;padding:9px 14px;border:none;border-radius:20px;font-size:.95em;}
.controls button{border:none;border-radius:18px;padding:9px 16px;font-size:.9em;cursor:pointer;font-weight:600;}
button.sec{background:#e9edef;color:#111b21;}
button.sec:hover{background:#dfe5e7;}
button.primary{background:#25d366;color:#053d29;}
button.primary:hover{background:#1fb457;}
button.primary:disabled{background:#8fd3ab;color:#eafff2;cursor:not-allowed;}
.limwrap{font-size:.85em;color:#eafff2;display:flex;align-items:center;gap:6px;}
.limwrap input{width:64px;padding:7px 8px;border:none;border-radius:8px;font-size:.9em;}
.list{flex:1;overflow-y:auto;padding:8px 16px 24px;}
.row{display:flex;align-items:center;gap:10px;background:#fff;border-radius:8px;padding:9px 14px;margin:6px 0;cursor:pointer;box-shadow:0 1px 1px rgba(0,0,0,.08);}
.row:hover{background:#f5f6f6;}
.row input{width:18px;height:18px;flex:none;cursor:pointer;}
.row .nm{flex:1;word-break:break-word;}
.badge{font-size:.72em;font-weight:700;padding:2px 8px;border-radius:10px;flex:none;}
.badge.g{background:#e7f5ee;color:#0a7a4f;}
.badge.c{background:#eef1f4;color:#54656f;}
.empty{color:#667781;padding:24px;text-align:center;}
`;

// Client-Skript des Auswahlfensters. Sendet die Auswahl per exposeFunction zurück.
const GUI_JS = `<script>
(function(){
  var DATA=window.DATA||[], LIM=window.DEFAULT_LIMIT||0;
  var list=document.getElementById('list'), q=document.getElementById('q'),
      cnt=document.getElementById('cnt'), startBtn=document.getElementById('start'),
      limInput=document.getElementById('lim'), sinceInput=document.getElementById('since');
  if(LIM>0) limInput.value=LIM;
  if(window.DEFAULT_SINCE) sinceInput.value=window.DEFAULT_SINCE;
  var checked=Object.create(null);
  function esc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
  function fold(s){return (s||'').toLowerCase();}
  function count(){return Object.keys(checked).length;}
  function updateCount(){var n=count();cnt.textContent=n;startBtn.disabled=n===0;}
  function render(){
    var term=fold(q.value.trim());
    var html='';
    for(var k=0;k<DATA.length;k++){
      var d=DATA[k];
      if(term && fold(d.name).indexOf(term)<0) continue;
      html+='<label class="row"><input type="checkbox" data-i="'+d.i+'"'+(checked[d.i]?' checked':'')+'>'+
        '<span class="badge '+(d.g?'g':'c')+'">'+(d.g?'Gruppe':'Chat')+'</span><span class="nm">'+esc(d.name)+'</span></label>';
    }
    list.innerHTML=html||'<div class="empty">Keine Chats gefunden.</div>';
    updateCount();
  }
  list.addEventListener('change',function(e){
    var cb=e.target; if(cb&&cb.type==='checkbox'){var i=cb.getAttribute('data-i'); if(cb.checked)checked[i]=true; else delete checked[i]; updateCount();}
  });
  q.addEventListener('input',render);
  document.getElementById('all').addEventListener('click',function(){
    var term=fold(q.value.trim());
    for(var k=0;k<DATA.length;k++){var d=DATA[k]; if(!term||fold(d.name).indexOf(term)>=0) checked[d.i]=true;}
    render();
  });
  document.getElementById('none').addEventListener('click',function(){checked=Object.create(null);render();});
  startBtn.addEventListener('click',function(){
    var sel=Object.keys(checked).map(Number);
    var lim=parseInt(limInput.value,10); if(isNaN(lim)||lim<0)lim=0;
    startBtn.disabled=true; startBtn.textContent='Wird gestartet ...';
    window.backupSubmit(JSON.stringify({selected:sel,limit:lim,since:sinceInput.value||''}));
  });
  render();
})();
</script>`;

function buildSelectGuiHtml(list, defaultLimit, defaultSince) {
    const json = JSON.stringify(list).replace(/</g, '\\u003c');
    return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chats auswählen</title><style>${GUI_CSS}</style></head><body>
<div class="top">
  <h1>WhatsApp-Backup &middot; Chats zum Sichern auswählen</h1>
  <div class="controls">
    <input id="q" type="search" placeholder="Chats suchen ..." autocomplete="off">
    <button id="all" class="sec" type="button">Alle</button>
    <button id="none" class="sec" type="button">Keine</button>
    <span class="limwrap">Nachrichten/Chat <input id="lim" type="number" min="0" value="0" title="0 = alle"></span>
    <span class="limwrap" title="Nur Nachrichten ab diesem Datum (Anordnungszeitpunkt). Leer = alle.">ab Datum <input id="since" type="date"></span>
    <button id="start" class="primary" type="button" disabled>Sicherung starten (<span id="cnt">0</span>)</button>
  </div>
  <p style="margin:10px 0 0;font-size:.85em">Vor dem Export werden die ausgewählten Chats automatisch bis zur ältesten verfügbaren Nachricht geladen. Das kann dauern.</p>
</div>
<div id="list" class="list"></div>
<script>window.DATA=${json};window.DEFAULT_LIMIT=${Number(defaultLimit) || 0};window.DEFAULT_SINCE=${JSON.stringify(defaultSince || '')};</script>
${GUI_JS}
</body></html>`;
}

// Öffnet im vorhandenen Browser einen Tab mit der Auswahl-GUI und wartet auf die
// Auswahl. Rückgabe: { chats: [...], limit: n, cancelled: bool }.
async function selectChatsGui(client, chats) {
    const browser = client.pupBrowser;
    if (!browser) throw new Error('kein Browser verfügbar');
    const page = await browser.newPage();
    try {
        let settle;
        const selection = new Promise((resolve) => { settle = resolve; });
        let settled = false;
        const finish = (val) => { if (!settled) { settled = true; settle(val); } };

        await page.exposeFunction('backupSubmit', (json) => {
            let p;
            try { p = JSON.parse(json); } catch (e) { p = { selected: [], limit: 0, since: '' }; }
            finish(p);
        });
        page.on('close', () => finish({ selected: [], limit: 0, since: '', cancelled: true }));

        const guiList = chats.map((c, i) => ({ i, name: chatDisplayName(c), g: c.isGroup ? 1 : 0 }));
        const defSince = SINCE_TS ? new Date(SINCE_TS * 1000).toISOString().slice(0, 10) : '';
        await page.setContent(buildSelectGuiHtml(guiList, limitArgGiven ? MESSAGE_LIMIT : 0, defSince),
            { waitUntil: 'domcontentloaded' });
        await page.bringToFront().catch(() => {});
        console.log('Bitte im geöffneten Auswahlfenster die Chats wählen und auf "Sicherung starten" klicken ...');

        const payload = await selection;
        if (payload.cancelled) return { chats: [], limit: 0, cancelled: true };
        const chosen = (payload.selected || []).map((i) => chats[i]).filter(Boolean);
        const limit = (typeof payload.limit === 'number' && payload.limit > 0) ? payload.limit : 0;
        return { chats: chosen, limit, since: payload.since || '', cancelled: false };
    } finally {
        await page.close().catch(() => {});
    }
}

// Menschenlesbare Beschreibung eines Limits.
function limitLabel(n) {
    return n && n > 0 && n !== ALL ? String(n) : 'alle';
}

// Interne Grenze fürs Nachrichten-Limit: 0/alle -> große Zahl.
function effectiveMsgLimit() {
    return MESSAGE_LIMIT && MESSAGE_LIMIT > 0 ? MESSAGE_LIMIT : ALL;
}

// -------- Fortschrittsanzeige ------------------------------------------------

function progressBar(fraction, width = 22) {
    const f = Math.max(0, Math.min(1, fraction));
    const filled = Math.round(f * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Schreibt eine sich selbst überschreibende Statuszeile (nur bei echtem Terminal;
// sonst nichts, damit Logdateien nicht mit Steuerzeichen zugemüllt werden).
function writeStatus(line) {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 80;
    const text = line.length > cols - 1 ? line.slice(0, cols - 1) : line.padEnd(cols - 1);
    process.stdout.write('\r' + text);
}

function clearStatus() {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 80;
    process.stdout.write('\r' + ' '.repeat(cols - 1) + '\r');
}

// -------- Integrität: Prüfsummen-Manifest ------------------------------------
//
// Am Ende jedes Backups wird für jede Datei ein SHA-256-Hash berechnet und in
// manifest.json geschrieben; manifest.sha256 enthält den Hash des Manifests
// selbst. "node backup.js --pruefen [ordner]" rechnet alles nach und meldet
// veränderte, fehlende oder zusätzliche Dateien.

function hashFileSync(file) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(1024 * 1024);
        let n;
        while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
    } finally {
        fs.closeSync(fd);
    }
    return h.digest('hex');
}

// Alle Dateien unterhalb von dir (relative Pfade mit "/"), ohne Manifestdateien.
function listBackupFiles(dir, base = '') {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...listBackupFiles(path.join(dir, e.name), rel));
        else if (rel !== 'manifest.json' && rel !== 'manifest.sha256') out.push(rel);
    }
    return out;
}

function writeManifest(runDir, meta) {
    const files = {};
    let totalBytes = 0;
    for (const rel of listBackupFiles(runDir).sort()) {
        const full = path.join(runDir, rel);
        const bytes = fs.statSync(full).size;
        files[rel] = { sha256: hashFileSync(full), bytes };
        totalBytes += bytes;
    }
    const manifest = {
        format: 'whatsapp-backup-manifest/1',
        algorithmus: 'sha256',
        erstellt: new Date().toISOString(),
        ...meta,
        dateien: Object.keys(files).length,
        gesamtGroesseBytes: totalBytes,
        pruefsummen: files
    };
    const json = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(runDir, 'manifest.json'), json);
    fs.writeFileSync(path.join(runDir, 'manifest.sha256'),
        crypto.createHash('sha256').update(json).digest('hex') + '  manifest.json\n');
    return manifest;
}

// Prüft einen Backup-Ordner gegen sein Manifest. Rückgabe: Ergebnisobjekt.
function verifyBackup(runDir) {
    const manifestPath = path.join(runDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { fatal: 'Kein manifest.json gefunden - Backup wurde vor Einführung der Integritätsprüfung erstellt.' };
    const json = fs.readFileSync(manifestPath, 'utf8');

    // Erst das Manifest selbst gegen manifest.sha256 prüfen.
    let manifestOk = null;
    const sumPath = path.join(runDir, 'manifest.sha256');
    if (fs.existsSync(sumPath)) {
        const expected = String(fs.readFileSync(sumPath, 'utf8')).trim().split(/\s+/)[0];
        manifestOk = crypto.createHash('sha256').update(json).digest('hex') === expected;
    }

    let manifest;
    // BOM tolerieren (z. B. nach erneutem Speichern in einem Windows-Editor);
    // die Veränderung selbst fällt dann über manifest.sha256 auf.
    try { manifest = JSON.parse(json.replace(/^﻿/, '')); }
    catch (e) { return { fatal: 'manifest.json ist beschädigt (kein gültiges JSON).' }; }
    const expected = manifest.pruefsummen || {};

    const changed = [], missing = [], extra = [];
    let okCount = 0;
    const actual = new Set(listBackupFiles(runDir));
    for (const rel of Object.keys(expected)) {
        const full = path.join(runDir, rel);
        if (!actual.has(rel) || !fs.existsSync(full)) { missing.push(rel); continue; }
        if (hashFileSync(full) === expected[rel].sha256) okCount++;
        else changed.push(rel);
    }
    for (const rel of actual) if (!expected[rel]) extra.push(rel);

    return { manifestOk, total: Object.keys(expected).length, okCount, changed, missing, extra, erstellt: manifest.erstellt };
}

// Konsolen-Ausgabe der Prüfung; Rückgabe true = alles in Ordnung.
function runVerify(runDir) {
    console.log(`Prüfe Backup: ${runDir}\n`);
    const r = verifyBackup(runDir);
    if (r.fatal) { console.error(r.fatal); return false; }
    if (r.manifestOk === false) console.error('WARNUNG: manifest.json stimmt nicht mit manifest.sha256 überein (Manifest verändert?)');
    for (const f of r.changed) console.error(`  VERÄNDERT: ${f}`);
    for (const f of r.missing) console.error(`  FEHLT:     ${f}`);
    for (const f of r.extra) console.log(`  ZUSÄTZLICH (nicht im Manifest): ${f}`);
    const ok = r.manifestOk !== false && !r.changed.length && !r.missing.length;
    console.log(`\n${r.okCount} von ${r.total} Dateien unverändert`
        + ` (Manifest vom ${r.erstellt ? new Date(r.erstellt).toLocaleString('de-DE') : '?'}).`);
    console.log(ok
        ? 'ERGEBNIS: Backup ist unverändert und vollständig. ✔'
        : `ERGEBNIS: Abweichungen gefunden - ${r.changed.length} verändert, ${r.missing.length} fehlend.`);
    return ok;
}

// Neuesten Backup-Ordner (mit manifest.json bevorzugt) unter backup/ finden.
function newestRunDir() {
    if (!fs.existsSync(BACKUP_ROOT)) return null;
    const dirs = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(BACKUP_ROOT, e.name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs.find((d) => fs.existsSync(path.join(d, 'manifest.json'))) || dirs[0] || null;
}

// ---------------------------------------------------------------- Hilfsfunktionen

function sanitizeName(name) {
    return (name || 'unbenannt')
        .replace(/[<>:"/\\|?* -]/g, '_')
        .replace(/[.\s]+$/g, '')
        .slice(0, 80)
        .trim() || 'unbenannt';
}

const EXT_BY_MIME = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
    'text/vcard': 'vcf'
};

function extForMime(mimetype, filename) {
    if (filename && filename.includes('.')) {
        return filename.split('.').pop().toLowerCase().slice(0, 8);
    }
    const base = (mimetype || '').split(';')[0].trim();
    if (EXT_BY_MIME[base]) return EXT_BY_MIME[base];
    const sub = base.split('/')[1];
    return sub ? sub.replace(/[^a-z0-9]/gi, '').slice(0, 8) : 'bin';
}

// In aktuellen WhatsApp-Web-Versionen heißt das serialisierte ID-Feld teils
// "$1" statt "_serialized" (Minifizierungs-Artefakt). Beide Varianten abdecken.
function serializedId(id) {
    if (!id) return null;
    return id._serialized || id.$1 || (id.fromMe !== undefined && id.remote && id.id
        ? `${id.fromMe}_${id.remote}_${id.id}` : null);
}

function fmtDate(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// -------- Sondertypen: Anrufe & Kontaktkarten --------------------------------

function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

// Extrahiert Name und Telefonnummern aus einem vCard-Text.
function parseVcard(text) {
    const t = String(text || '');
    let name = '';
    const fn = /(?:^|\n)FN:(.*)/i.exec(t);
    if (fn) name = fn[1].trim();
    if (!name) {
        const n = /(?:^|\n)N:(.*)/i.exec(t);
        if (n) name = n[1].replace(/;+/g, ' ').trim();
    }
    const phones = [];
    const re = /(?:^|\n)TEL[^:\n]*:(.*)/ig;
    let m;
    while ((m = re.exec(t))) {
        const v = m[1].trim();
        if (v) phones.push(v);
    }
    return { name: name || 'Kontakt', phones };
}

function extractContacts(msg) {
    const cards = (msg.vCards && msg.vCards.length) ? msg.vCards : (msg.body ? [msg.body] : []);
    return cards.map(parseVcard);
}

// Kontakte eines Datensatzes: strukturiert gespeichert, sonst aus dem vCard-Text.
function recContacts(rec) {
    if (rec.contacts && rec.contacts.length) return rec.contacts;
    if (rec.body) return extractContacts({ body: rec.body });
    return [];
}

// Best-effort-Auswertung eines Anruf-Eintrags aus den Rohdaten der Nachricht.
// WhatsApp benennt diese Felder je nach Version unterschiedlich, daher werden
// alle plausiblen Schlüssel abgegriffen und die Rohwerte zusätzlich mitgespeichert
// (rec.call.raw), damit die Erkennung bei Bedarf präzise nachgezogen werden kann.
function extractCall(msg) {
    const d = msg._data || {};
    let duration = Number(msg.duration) > 0 ? Number(msg.duration) : 0;
    let video = false;
    const raw = {};
    for (const k of Object.keys(d)) {
        const v = d[k];
        if (v !== null && typeof v === 'object') continue;
        if (/call|video|miss|dur|outcome|result|subtype|offer|ptt/i.test(k)) raw[k] = v;
        if (typeof v === 'number' && /dur/i.test(k) && v > duration) duration = v;
        if (v && /video/i.test(k)) video = true;
    }
    const hint = String(d.subtype || d.callType || d.callOutcome || '');
    if (/video/i.test(hint)) video = true;
    return { video, duration, missed: !(duration > 0) && !msg.fromMe, raw };
}

function callText(rec) {
    const c = rec.call || {};
    const kind = c.video ? 'Videoanruf' : 'Sprachanruf';
    if (c.duration > 0) return `${kind} · ${fmtDuration(c.duration)}`;
    if (rec.fromMe) return `${kind} · keine Antwort`;
    return `Verpasster ${kind}`;
}

// -------- Gruppen-Systemereignisse (gp2) -------------------------------------

// Namen für eine Teilnehmer-ID: aufgelöster Name > Telefonnummer > "jemand".
function nameForId(id, nameCache) {
    if (!id) return '';
    const n = nameCache && nameCache.get(id);
    if (n) return n;
    const m = /^(\d+)@c\.us$/.exec(id);
    if (m) return '+' + m[1];
    return '';
}

// Erfasst ein Gruppen-Ereignis aus der Nachricht und löst die Namen auf.
function extractGroupEvent(msg, nameCache) {
    const d = msg._data || {};
    const subtype = String(d.subtype || msg.subtype || '');
    const authorId = serializedId(msg.author) || (typeof msg.author === 'string' ? msg.author : '') || '';
    const rawRecipients = Array.isArray(d.recipients) ? d.recipients : [];
    const members = rawRecipients
        .map((r) => (typeof r === 'object' ? serializedId(r) : r))
        .map((id) => nameForId(id, nameCache) || 'jemand');
    return { subtype, actor: nameForId(authorId, nameCache), members };
}

function joinNames(list) {
    const a = (list || []).filter(Boolean);
    if (!a.length) return 'Jemand';
    if (a.length === 1) return a[0];
    if (a.length === 2) return `${a[0]} und ${a[1]}`;
    return `${a.slice(0, -1).join(', ')} und ${a[a.length - 1]}`;
}

// Lesbarer deutscher Text für ein Gruppen-Ereignis.
function groupEventText(rec) {
    const g = rec.group || {};
    // USB-Weg liefert den Text bereits dekodiert (usb-backup.js describeSystemEvent).
    if (g.text) return g.text;
    const st = (g.subtype || '').toLowerCase();
    const members = joinNames(g.members);
    const plural = (g.members || []).filter(Boolean).length > 1;
    const actor = rec.fromMe ? 'Du' : (g.actor || 'Jemand');
    const hat = rec.fromMe ? 'hast' : 'hat';
    switch (st) {
        case 'add': return `${members} wurde${plural ? 'n' : ''} hinzugefügt`;
        case 'invite': return `${members} ist über den Einladungslink beigetreten`;
        case 'remove': return `${members} wurde${plural ? 'n' : ''} entfernt`;
        case 'leave': return `${actor} ${hat} die Gruppe verlassen`;
        case 'promote': return `${members} ist jetzt Admin`;
        case 'demote': return `${members} ist kein Admin mehr`;
        case 'subject': return `Gruppenname geändert${rec.body ? `: „${rec.body}"` : ''}`;
        case 'description': return 'Gruppenbeschreibung geändert';
        case 'picture': return 'Gruppenbild geändert';
        case 'announce':
        case 'restrict':
        case 'no_frequently_forwarded':
        case 'membership_approval_mode': return 'Gruppeneinstellungen geändert';
        case 'create':
        case 'created': return `${actor} ${hat} die Gruppe erstellt`;
        case 'membership_approval_request': return `${members} möchte der Gruppe beitreten`;
        default: return g.subtype ? `Gruppen-Update (${g.subtype})` : 'Gruppen-Update';
    }
}

// Lesbarer Klartext einer Nachricht (für Suche/Index), auch für Sondertypen.
function messagePlain(rec) {
    if (rec.type === 'call_log') return callText(rec);
    if (rec.type === 'vcard' || rec.type === 'multi_vcard') {
        const cs = recContacts(rec);
        const parts = cs.map((c) => c.name + (c.phones && c.phones.length ? ' ' + c.phones.join(' ') : ''));
        return 'Kontakt: ' + (parts.join('; ') || '');
    }
    if (rec.type === 'revoked') return 'Nachricht gelöscht';
    if (rec.type === 'gp2') return groupEventText(rec);
    return rec.body || '';
}

// HTML-Inhalt für Sondertypen (Anruf/Kontakt/gelöscht); null = normale Nachricht.
function specialBubbleHtml(rec) {
    if (rec.type === 'call_log') {
        const c = rec.call || {};
        const missed = !(c.duration > 0) && !rec.fromMe;
        const icon = c.video ? '📹' : '📞';
        return `<span class="body special call${missed ? ' missed' : ''}">${icon} ${escapeHtml(callText(rec))}</span>`;
    }
    if (rec.type === 'vcard' || rec.type === 'multi_vcard') {
        const cs = recContacts(rec);
        if (!cs.length) return '<span class="body special contact">👤 Kontakt</span>';
        const items = cs.map((c) => {
            const ph = (c.phones || []).map(escapeHtml).join(', ');
            return `👤 <b>${escapeHtml(c.name || 'Kontakt')}</b>${ph ? ` — ${ph}` : ''}`;
        }).join('<br>');
        return `<span class="body special contact">${items}</span>`;
    }
    if (rec.type === 'revoked') {
        return '<span class="body special deleted">🚫 Diese Nachricht wurde gelöscht</span>';
    }
    if (rec.type === 'gp2') {
        const icon = (rec.group && rec.group.icon) || '👥';
        return `<span class="body special group">${escapeHtml(icon)} ${escapeHtml(groupEventText(rec))}</span>`;
    }
    return null;
}

// ---------------------------------------------------------------- HTML-Ausgabe

const CHAT_CSS = `
body{font-family:Segoe UI,Arial,sans-serif;background:#e5ddd5;margin:0;padding:0 16px 16px;}
.top{background:#075e54;color:#fff;padding:10px 16px;margin:0 -16px 16px;position:sticky;top:0;z-index:5;box-shadow:0 2px 4px rgba(0,0,0,.2);}
.top h1{font-size:1.15em;margin:0 0 6px;}
.meta .wal{background:#fff3c4;color:#6b5200;border-radius:6px;padding:0 5px;font-size:.9em;font-weight:600;}
.top .kontakt{font-size:.82em;color:#c7f0e4;margin:-2px 0 8px;}
.top .kontakt b{color:#fff;font-weight:600;}
.top a.back{color:#a7f3d0;font-size:.85em;text-decoration:none;}
.top a.back:hover{text-decoration:underline;}
.searchrow{display:flex;gap:8px;align-items:center;margin-top:8px;}
.searchrow input{flex:1;padding:7px 10px;border:none;border-radius:16px;font-size:.9em;}
.searchrow .cnt{font-size:.8em;color:#d1fae5;white-space:nowrap;}
.msg{max-width:65%;margin:6px 0;padding:8px 12px;border-radius:8px;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.15);width:fit-content;word-wrap:break-word;white-space:pre-wrap;scroll-margin-top:90px;}
.msg.me{background:#dcf8c6;margin-left:auto;}
.msg.hide{display:none;}
.meta{font-size:.72em;color:#667781;margin-top:4px;}
.author{font-size:.8em;font-weight:bold;color:#075e54;margin-bottom:2px;}
.msg img,.msg video{max-width:100%;border-radius:6px;display:block;margin-bottom:4px;}
.msg audio{display:block;margin-bottom:4px;}
a{color:#039be5;}
.sys{text-align:center;font-size:.8em;color:#667781;margin:8px 0;}
mark{background:#ffe08a;padding:0 1px;border-radius:2px;}
.msg:target{animation:flash 2s ease;box-shadow:0 0 0 3px #ffb300;}
@keyframes flash{0%,60%{box-shadow:0 0 0 3px #ffb300;}100%{box-shadow:0 1px 1px rgba(0,0,0,.15);}}
.body.call{color:#075e54;font-style:italic;}
.body.call.missed{color:#c0392b;}
.body.contact b{color:#075e54;}
.body.deleted{color:#8696a0;font-style:italic;}
.msg.system{background:#e2f0e6;box-shadow:none;max-width:80%;margin:8px auto;text-align:center;}
.msg.system .body{color:#3b6b57;font-size:.82em;}
.msg.system .meta{text-align:center;}
.msg{position:relative;}
.mark{position:absolute;top:-9px;right:-9px;width:24px;height:24px;border:none;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:pointer;font-size:13px;line-height:22px;padding:0;opacity:0;transition:opacity .15s;}
.msg:hover .mark{opacity:1;}
.msg.marked{box-shadow:0 0 0 2px #e2b93b;}
.msg.marked .mark{opacity:1;background:#ffd54d;}
.top a.evid{color:#ffd54d;font-size:.85em;text-decoration:none;margin-left:14px;}
.top a.evid:hover{text-decoration:underline;}
`;

function mediaHtml(rec) {
    if (!rec.mediaFile) {
        return rec.hasMedia ? '<div class="sys">[Medium nicht verfügbar]</div>' : '';
    }
    const src = `media/${encodeURIComponent(rec.mediaFile)}`;
    const mime = rec.mediaMimetype || '';
    if (mime.startsWith('image/')) return `<a href="${src}" target="_blank"><img src="${src}" loading="lazy"></a>`;
    if (mime.startsWith('video/')) return `<video src="${src}" controls preload="none"></video>`;
    if (mime.startsWith('audio/')) return `<audio src="${src}" controls preload="none"></audio>`;
    return `<a href="${src}" target="_blank">📎 ${escapeHtml(rec.mediaFile)}</a>`;
}

// Kontaktzeile unter dem Chatnamen (nur USB-Weg: Adressbuch, WhatsApp-Name, Nummer).
function contactLineHtml(contact) {
    if (!contact) return '';
    const parts = [['Adressbuch', contact.name], ['WhatsApp-Name', contact.waName], ['Nummer', contact.number]]
        .filter(([, v]) => v).map(([k, v]) => `${k}: <b>${escapeHtml(v)}</b>`);
    return parts.length ? `<div class="kontakt">${parts.join(' &middot; ')}</div>` : '';
}

function writeChatHtml(chatDir, chatName, records, isGroup, dirName, contact = null) {
    const rows = records.map((r, i) => {
        // Gruppen-Ereignisse als zentrierte Systemzeile, ohne Absender/Bubble.
        const isSystem = r.type === 'gp2';
        const author = (isGroup && !r.fromMe && r.senderName && !isSystem)
            ? `<div class="author">${escapeHtml(r.senderName)}</div>` : '';
        // Sondertypen (Anruf/Kontakt/gelöscht/Gruppe) hübsch darstellen, sonst Text.
        const special = specialBubbleHtml(r);
        const bodyHtml = special !== null ? special : `<span class="body">${escapeHtml(r.body)}</span>`;
        const cls = isSystem ? 'msg system' : `msg${r.fromMe ? ' me' : ''}`;
        return `<div class="${cls}" id="m${i}">${author}${mediaHtml(r)}${bodyHtml}<div class="meta">${escapeHtml(r.date)}${r.walHerkunft ? ` <span class="wal" title="Stand stammt aus dem Write-Ahead-Log (${escapeHtml(r.walHerkunft)}), siehe wal-bericht.html">WAL</span>` : ''}</div><button class="mark" title="Als Beweis markieren / Markierung entfernen">⚖️</button></div>`;
    }).join('\n');
    const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(chatName)}</title><style>${CHAT_CSS}</style></head><body>
<div class="top">
  <a class="back" href="../index.html">&larr; Zurück zur Übersicht</a><a class="evid" href="../beweise.html">⚖️ Beweise (<span id="bcnt">0</span>)</a>
  <h1>${escapeHtml(chatName)}</h1>
  ${contactLineHtml(contact)}
  <div class="searchrow">
    <input type="search" id="q" placeholder="In diesem Chat suchen ...">
    <span class="cnt" id="cnt"></span>
  </div>
</div>
${rows}
<script>window.BACKUP_ID=${JSON.stringify(BACKUP_ID).replace(/</g, '\\u003c')};window.CHAT_DIR=${JSON.stringify(dirName || '').replace(/</g, '\\u003c')};</script>
${CHAT_SEARCH_JS}
${MARKS_JS}
</body></html>`;
    fs.writeFileSync(path.join(chatDir, 'chat.html'), html);
}

// Beweis-Markierungen: gemeinsames Client-Skript für chat.html. Speicherung im
// localStorage des Browsers unter einem backup-spezifischen Schlüssel; dadurch
// funktionieren Markierungen komplett offline und über Seiten hinweg.
const MARKS_JS = `<script>
(function(){
  var KEY='wab:marks:'+(window.BACKUP_ID||''), DIR=window.CHAT_DIR||'';
  function load(){try{var v=JSON.parse(localStorage.getItem(KEY));return (v&&v.c&&v.m)?v:{c:{},m:{}};}catch(e){return {c:{},m:{}};}}
  function save(v){try{localStorage.setItem(KEY,JSON.stringify(v));}catch(e){alert('Markierung konnte nicht gespeichert werden (Browser-Speicher nicht verfügbar).');}}
  function refresh(){
    var v=load();
    [].forEach.call(document.querySelectorAll('.msg'),function(el){
      el.classList.toggle('marked', !!v.m[DIR+'/'+el.id.slice(1)]);
    });
    var n=Object.keys(v.c).length+Object.keys(v.m).length;
    var b=document.getElementById('bcnt'); if(b)b.textContent=n;
  }
  document.addEventListener('click',function(e){
    var btn=e.target.closest?e.target.closest('.mark'):null;
    if(!btn)return;
    var msg=btn.closest('.msg'); if(!msg)return;
    var k=DIR+'/'+msg.id.slice(1);
    var v=load(); if(v.m[k])delete v.m[k]; else v.m[k]=1;
    save(v); refresh();
  });
  window.addEventListener('storage',refresh);
  window.addEventListener('focus',refresh);
  refresh();
})();
</script>`;

// In-Chat-Suche: filtert Nachrichten live und hebt Fundstellen hervor.
const CHAT_SEARCH_JS = `<script>
(function(){
  var q=document.getElementById('q'), cnt=document.getElementById('cnt');
  var msgs=[].slice.call(document.querySelectorAll('.msg'));
  var bodies=msgs.map(function(m){var b=m.querySelector('.body');return {el:m,body:b,special:b&&b.classList.contains('special'),orig:b?b.textContent:'',low:(m.textContent||'').toLowerCase()};});
  function esc(s){return s.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');}
  function run(){
    var term=q.value.trim().toLowerCase();
    var shown=0;
    var re=term?new RegExp('('+esc(term)+')','ig'):null;
    bodies.forEach(function(o){
      var hit=!term||o.low.indexOf(term)>=0;
      o.el.classList.toggle('hide',!hit);
      if(hit)shown++;
      if(o.body&&!o.special){
        if(term&&o.body.textContent.toLowerCase().indexOf(term)>=0){
          o.body.innerHTML=o.orig.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}).replace(re,'<mark>$1</mark>');
        } else if(o.body.innerHTML!==o.orig){
          o.body.textContent=o.orig;
        }
      }
    });
    cnt.textContent=term?(shown+' Treffer'):'';
  }
  q.addEventListener('input',run);
})();
</script>`;

// -------- Technische Doku als HTML beilegen ----------------------------------
//
// DOKUMENTATION.md ist die Quelle; bei jedem Backup wird daraus eine formatierte
// dokumentation.html im Backup-Ordner erzeugt. Der Mini-Umwandler unterstützt
// genau die in der Doku verwendeten Markdown-Elemente (Überschriften, Listen,
// Tabellen, Codeblöcke, Zitate, Fett, Inline-Code, Links).

function mdInline(s) {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // Nur Web-Links klickbar lassen; Datei-Links wären im Backup-Ordner kaputt.
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) =>
        /^https?:\/\//.test(url) ? `<a href="${url}" target="_blank">${txt}</a>` : `<b>${txt}</b>`);
    return t;
}

function markdownToHtml(md) {
    const lines = md.split(/\r?\n/);
    const out = [];
    const toc = [];
    let para = [], list = null, quote = [], code = null, table = null, h2count = 0;

    const flush = () => {
        if (para.length) { out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; }
        if (list) { out.push(list.html + (list.ordered ? '</ol>' : '</ul>')); list = null; }
        if (quote.length) { out.push(`<blockquote>${mdInline(quote.join(' '))}</blockquote>`); quote = []; }
        if (table) { out.push(table.html + '</table>'); table = null; }
    };

    for (const line of lines) {
        // Codeblöcke (```)
        if (code !== null) {
            if (/^```/.test(line)) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
            else code.push(line);
            continue;
        }
        if (/^```/.test(line)) { flush(); code = []; continue; }

        // Tabellen (| ... |)
        if (/^\s*\|/.test(line)) {
            const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
            if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // Trennzeile
            if (!table) { flush(); table = { html: `<table><tr>${cells.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr>`, header: true }; }
            else table.html += `<tr>${cells.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`;
            continue;
        }
        if (table) flush();

        // Überschriften, Trennlinie, Zitat
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        if (h) {
            flush();
            const level = h[1].length;
            if (level === 2) {
                h2count++;
                const id = `abschnitt-${h2count}`;
                toc.push({ id, text: h[2] });
                out.push(`<h2 id="${id}">${mdInline(h[2])}</h2>`);
            } else out.push(`<h${level}>${mdInline(h[2])}</h${level}>`);
            continue;
        }
        if (/^---+\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
        if (/^>\s?/.test(line)) {
            if (para.length || list || table) flush();
            quote.push(line.replace(/^>\s?/, ''));
            continue;
        }
        if (quote.length) flush();

        // Listen (-, 1.) inkl. eingerückter Folgezeilen und Unterpunkte
        const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
        if (li) {
            const indented = li[1].length >= 2;
            const ordered = /\d+\./.test(li[2]);
            if (list && indented) { list.html += `<br><span class="sub">– ${mdInline(li[3])}</span>`; continue; }
            if (para.length || quote.length || table) flush();
            if (!list || list.ordered !== ordered) { flush(); list = { ordered, html: ordered ? '<ol>' : '<ul>', open: false }; }
            if (list.open) list.html += '</li>';
            list.html += `<li>${mdInline(li[3])}`;
            list.open = true;
            continue;
        }
        // Eingerückte Fortsetzung eines Listenpunkts
        if (list && /^\s{2,}\S/.test(line)) { list.html += ' ' + mdInline(line.trim()); continue; }

        // Leerzeile beendet den aktuellen Block
        if (!line.trim()) { flush(); continue; }

        para.push(line.trim());
    }
    flush();
    return { body: out.join('\n'), toc };
}

const DOC_CSS = `
*{box-sizing:border-box;}
body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f0f2f5;color:#111b21;line-height:1.55;}
.top{background:#075e54;color:#fff;padding:16px 24px;}
.top h1{margin:0;font-size:1.3em;}
.top .sub{font-size:.85em;color:#c7f0e4;margin-top:4px;}
.top a{color:#c7f0e4;}
.wrap{max-width:860px;margin:0 auto;padding:8px 20px 48px;}
nav{background:#fff;border-radius:8px;padding:12px 18px;margin:18px 0;box-shadow:0 1px 3px rgba(0,0,0,.12);}
nav b{display:block;margin-bottom:6px;color:#075e54;}
nav a{display:inline-block;margin:2px 10px 2px 0;color:#075e54;text-decoration:none;font-size:.92em;}
nav a:hover{text-decoration:underline;}
h2{color:#075e54;margin-top:36px;border-bottom:2px solid #d9e5e0;padding-bottom:4px;scroll-margin-top:12px;}
h3{color:#075e54;margin-top:24px;}
table{border-collapse:collapse;background:#fff;width:100%;box-shadow:0 1px 2px rgba(0,0,0,.1);margin:12px 0;}
th,td{padding:7px 12px;text-align:left;border-bottom:1px solid #eee;vertical-align:top;}
th{background:#075e54;color:#fff;}
code{background:#e9edef;border-radius:4px;padding:1px 5px;font-size:.92em;}
pre{background:#1f2c33;color:#e9edef;border-radius:8px;padding:14px 16px;overflow-x:auto;}
pre code{background:none;padding:0;color:inherit;}
blockquote{background:#fff8e6;border-left:4px solid #e2b93b;margin:14px 0;padding:10px 14px;border-radius:0 8px 8px 0;}
ul,ol{padding-left:24px;}
li{margin:5px 0;}
li .sub{color:#54656f;font-size:.95em;}
a{color:#075e54;}
hr{border:none;border-top:1px solid #d1d7db;margin:24px 0;}
.kontobox{background:#fff;border:2px solid #075e54;border-radius:10px;padding:14px 18px;margin:18px 0;box-shadow:0 1px 3px rgba(0,0,0,.12);}
.kontobox h2{border:none;margin-bottom:8px;}
.kontobox table{margin:0;}
.kontobox th{background:#eef5f2;color:#075e54;width:220px;}
`;

// Klartext-Namen für die Plattform-Kennung des Handys.
const PLATFORM_NAMES = {
    android: 'Android', iphone: 'iPhone', ios: 'iPhone',
    smba: 'Android (WhatsApp Business)', smbi: 'iPhone (WhatsApp Business)',
    wearos: 'Wear OS', web: 'Web', unknown: null
};

// Infoblock "Dieses Backup": Konto und Rahmendaten, steht ganz am Anfang der
// beigelegten Dokumentation (und im PDF-Anhang der Beweise-Seite).
function accountInfoHtml(meta) {
    if (!meta) return '';
    let lib = null;
    try { lib = require('whatsapp-web.js/package.json').version; } catch (e) { /* egal */ }
    const platform = meta.plattform
        ? (PLATFORM_NAMES[String(meta.plattform).toLowerCase()] || meta.plattform) : null;
    const row = (k, v) => (v === null || v === undefined || v === '')
        ? '' : `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`;
    const umfang = (meta.chats !== undefined)
        ? `${meta.chats} Chats (davon ${meta.gruppen || 0} Gruppen), ${meta.nachrichten} Nachrichten, ${meta.medien} Mediendateien`
        : null;
    return `<div class="kontobox">
<h2 id="konto" style="margin-top:0;">Dieses Backup</h2>
<table>
${row('WhatsApp-Konto', meta.konto ? '+' + meta.konto : null)}
${row('Profilname', meta.profilname)}
${row('Gerät/Plattform', platform)}
${row('Backup erstellt am', meta.erstellt)}
${row('Datenquelle', meta.quelle)}
${row('Write-Ahead-Log', meta.walHinweis)}
${row('Gesicherter Zeitraum', meta.zeitraum || 'gesamter verfügbarer Verlauf')}
${row('Backup-Ordner', meta.backupId)}
${row('Umfang', umfang)}
${row('WhatsApp-Web-Version', meta.waWebVersion)}
${row('Bibliothek', lib ? `whatsapp-web.js ${lib}` : null)}
${row('Laufzeitumgebung', `Node.js ${process.version} auf ${process.platform === 'win32' ? 'Windows' : process.platform}`)}
</table>
</div>`;
}

// Erzeugt dokumentation.html im Backup-Ordner aus DOKUMENTATION.md.
// meta (optional): Kontoinformationen für den Infoblock am Anfang.
function writeDocumentationHtml(runDir, meta) {
    const mdPath = path.join(__dirname, 'DOKUMENTATION.md');
    if (!fs.existsSync(mdPath)) return false;
    const md = fs.readFileSync(mdPath, 'utf8')
        .replace(/^# .*\r?\n/, ''); // H1 entfernen, kommt in den Seitenkopf
    const { body, toc } = markdownToHtml(md);
    const nav = toc.length
        ? `<nav><b>Inhalt</b>${toc.map((t) => `<a href="#${t.id}">${escapeHtml(t.text)}</a>`).join('')}</nav>`
        : '';
    const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Technische Dokumentation - WhatsApp-Backup</title><style>${DOC_CSS}</style></head><body>
<div class="top">
  <h1>Technische Dokumentation</h1>
  <div class="sub">So ist dieses Backup entstanden &middot; <a href="index.html">&larr; zur Übersicht</a></div>
</div>
<div class="wrap">
${accountInfoHtml(meta)}
${nav}
${body}
</div>
</body></html>`;
    fs.writeFileSync(path.join(runDir, 'dokumentation.html'), html);
    return true;
}

const INDEX_CSS = `
*{box-sizing:border-box;}
body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f0f2f5;color:#111b21;}
.top{background:#075e54;color:#fff;padding:16px 24px;position:sticky;top:0;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,.2);}
.top h1{margin:0;font-size:1.25em;}
.top .sub{font-size:.8em;color:#c7f0e4;margin-top:2px;}
.top .sub a{color:#a7f3d0;font-weight:400;}
.top .sub a.evlink{color:#ffd54d;}
.markchat,.markmsg{border:none;background:transparent;cursor:pointer;font-size:14px;opacity:.35;padding:2px 4px;vertical-align:middle;}
.markchat:hover,.markmsg:hover{opacity:1;}
.markchat.on,.markmsg.on{opacity:1;filter:drop-shadow(0 0 2px #e2b93b);}
.card{position:relative;padding-right:38px;}
.card .markmsg{position:absolute;top:8px;right:8px;}
.searchbar{display:flex;gap:10px;align-items:center;margin-top:12px;max-width:760px;}
.searchbar input{flex:1;padding:11px 16px;border:none;border-radius:24px;font-size:1em;box-shadow:0 1px 3px rgba(0,0,0,.25);}
.searchbar .hint{font-size:.8em;color:#c7f0e4;white-space:nowrap;}
.wrap{max-width:900px;margin:20px auto;padding:0 16px;}
table{border-collapse:collapse;background:#fff;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.15);border-radius:8px;overflow:hidden;}
th,td{padding:9px 16px;text-align:left;border-bottom:1px solid #eee;}
th{background:#075e54;color:#fff;font-weight:600;}
tr:last-child td{border-bottom:none;}
td.num{text-align:right;color:#667781;font-variant-numeric:tabular-nums;}
td.nowrap{white-space:nowrap;font-variant-numeric:tabular-nums;}
a{color:#075e54;font-weight:600;text-decoration:none;} a:hover{text-decoration:underline;}
.sectionhdr{margin:18px 4px 8px;font-size:.85em;font-weight:700;color:#54656f;text-transform:uppercase;letter-spacing:.04em;}
.chip{display:inline-block;background:#fff;border:1px solid #d1d7db;border-radius:16px;padding:5px 12px;margin:4px 6px 4px 0;font-size:.9em;}
.badge{display:inline-block;font-size:.72em;font-weight:700;padding:1px 7px;border-radius:10px;margin-right:6px;vertical-align:middle;}
.badge.g{background:#e7f5ee;color:#0a7a4f;}
.badge.c{background:#eef1f4;color:#54656f;}
.card{display:block;background:#fff;border-radius:8px;padding:10px 14px;margin:8px 0;box-shadow:0 1px 2px rgba(0,0,0,.12);color:inherit;}
.card:hover{box-shadow:0 2px 8px rgba(0,0,0,.18);text-decoration:none;}
.card .line1{font-size:.8em;color:#54656f;margin-bottom:3px;}
.card .who{font-weight:700;color:#075e54;}
.card .snippet{font-size:.95em;white-space:pre-wrap;word-break:break-word;}
mark{background:#ffe08a;padding:0 1px;border-radius:2px;}
.empty{color:#667781;padding:24px 4px;}
.more{color:#667781;font-size:.85em;margin:10px 4px;}
`;

// Baut die kompakte, in die Seite eingebettete Suchdatenstruktur.
function buildSearchData(entries) {
    return entries.map((e) => ({
        dir: e.dir,
        name: e.name,
        g: e.isGroup ? 1 : 0,
        c: e.messages,
        md: e.media,
        // Kontaktangaben (USB-Weg): Adressbuch, WhatsApp-Name, Nummer.
        k: e.contact ? [e.contact.name || '', e.contact.waName || '', e.contact.number || ''] : null,
        msgs: (e.records || []).map((r, i) => ({
            i,
            d: r.date,
            s: r.senderName,
            t: r.type,
            m: r.mediaFile ? 1 : 0,
            b: messagePlain(r)
        }))
    }));
}

// Client-Skript der Übersichtsseite: Live-Suche über Chatnamen und Inhalte.
const INDEX_JS = `<script>
(function(){
  var DATA = window.SEARCH_DATA || [];
  var q=document.getElementById('q'), hint=document.getElementById('hint'), out=document.getElementById('results');
  var TL={image:'Bild',video:'Video',ptt:'Sprachnachricht',audio:'Audio',document:'Dokument',sticker:'Sticker',location:'Standort',vcard:'Kontakt',gif:'GIF'};
  function tl(t){return TL[t]||'Anhang';}

  // Beweis-Markierungen (geteilt mit chat.html/beweise.html via localStorage)
  var MKEY='wab:marks:'+(window.BACKUP_ID||'');
  function mLoad(){try{var v=JSON.parse(localStorage.getItem(MKEY));return (v&&v.c&&v.m)?v:{c:{},m:{}};}catch(e){return {c:{},m:{}};}}
  function mSave(v){try{localStorage.setItem(MKEY,JSON.stringify(v));}catch(e){alert('Markierung konnte nicht gespeichert werden.');}}
  function mBadge(){
    var v=mLoad(), n=Object.keys(v.c).length+Object.keys(v.m).length;
    var b=document.getElementById('bcount'); if(b)b.textContent=n;
  }
  function fold(s){return (s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');}
  function esc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  function reEsc(t){return t.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');}
  var MAX=600;

  DATA.forEach(function(ch){
    ch._n=fold(ch.name+' '+(ch.k?ch.k.join(' '):''));
    ch.msgs.forEach(function(m){
      m._disp = m.b || (m.m||(m.t&&m.t!=='chat')?('['+tl(m.t)+']'):'');
      m._s = fold((m.s||'')+' '+(m.b||'')+' '+(m.m?tl(m.t):''));
    });
  });

  function badge(g){return '<span class="badge '+(g?'g':'c')+'">'+(g?'Gruppe':'Chat')+'</span>';}

  function hi(text, terms){
    if(!terms.length) return esc(text);
    var re=new RegExp('('+terms.map(reEsc).join('|')+')','ig');
    return esc(text).replace(re,'<mark>$1</mark>');
  }

  function snippet(body, term){
    if(!body) return '';
    var idx = term? body.toLowerCase().indexOf(term.toLowerCase()) : -1;
    if(idx<0) return body.length>180? body.slice(0,180)+'\\u2026' : body;
    var start=idx>70?idx-70:0;
    var s=body.slice(start,start+200);
    if(start>0)s='\\u2026'+s;
    if(start+200<body.length)s+='\\u2026';
    return s;
  }

  function renderDefault(){
    var v=mLoad();
    // Kontaktspalten nur, wenn Angaben vorliegen (USB-Weg mit wa.db).
    var hasK=DATA.some(function(ch){return ch.k&&(ch.k[0]||ch.k[1]||ch.k[2]);});
    var rows=DATA.map(function(ch){
      var on=!!v.c[ch.dir];
      var k=ch.k||['','',''];
      return '<tr><td><button class="markchat'+(on?' on':'')+'" data-dir="'+escAttr(ch.dir)+'" title="Ganzen Chat als Beweis markieren / entfernen">⚖️</button>'+badge(ch.g)+'<a href="'+escAttr(encodeURIComponent(ch.dir))+'/chat.html">'+esc(ch.name)+'</a></td>'+
        (hasK?'<td>'+esc(k[0])+'</td><td>'+esc(k[1])+'</td><td class="nowrap">'+esc(k[2])+'</td>':'')+
        '<td class="num">'+ch.c+'</td><td class="num">'+ch.md+'</td></tr>';
    }).join('');
    out.innerHTML='<table><tr><th>Chat</th>'+(hasK?'<th>Name im Adressbuch</th><th>WhatsApp-Name</th><th>Telefonnummer</th>':'')+'<th class="num">Nachrichten</th><th class="num">Medien</th></tr>'+rows+'</table>';
    hint.textContent='';
  }

  function renderResults(query){
    var terms=fold(query).split(/\\s+/).filter(Boolean);
    if(!terms.length){renderDefault();return;}
    var chatHits=DATA.filter(function(ch){return terms.every(function(t){return ch._n.indexOf(t)>=0;});});
    var msgHits=[];
    outer: for(var ci=0;ci<DATA.length;ci++){
      var ch=DATA[ci];
      for(var mi=0;mi<ch.msgs.length;mi++){
        var m=ch.msgs[mi];
        var ok=true;
        for(var ti=0;ti<terms.length;ti++){ if(m._s.indexOf(terms[ti])<0){ok=false;break;} }
        if(ok){ msgHits.push({ch:ch,m:m}); if(msgHits.length>MAX+1) break outer; }
      }
    }
    var html='';
    if(chatHits.length){
      html+='<div class="sectionhdr">Chats ('+chatHits.length+')</div>';
      html+=chatHits.map(function(ch){
        return '<span class="chip">'+badge(ch.g)+'<a href="'+escAttr(encodeURIComponent(ch.dir))+'/chat.html">'+hi(ch.name,terms)+'</a></span>';
      }).join('');
    }
    var capped=msgHits.length>MAX;
    var show=msgHits.slice(0,MAX);
    html+='<div class="sectionhdr">Nachrichten ('+(capped?(MAX+'+'):msgHits.length)+')</div>';
    if(!show.length){
      html+='<div class="empty">Keine Nachrichten gefunden.</div>';
    } else {
      var raw=query.trim().split(/\\s+/)[0];
      var vm=mLoad();
      html+=show.map(function(h){
        var m=h.m, ch=h.ch;
        var link=escAttr(encodeURIComponent(ch.dir))+'/chat.html#m'+m.i;
        var mk=ch.dir+'/'+m.i;
        return '<a class="card" href="'+link+'" target="_blank">'+
          '<button class="markmsg'+(vm.m[mk]?' on':'')+'" data-key="'+escAttr(mk)+'" title="Nachricht als Beweis markieren / entfernen">⚖️</button>'+
          '<div class="line1">'+badge(ch.g)+esc(ch.name)+' &middot; '+esc(m.d)+' &middot; <span class="who">'+esc(m.s)+'</span></div>'+
          '<div class="snippet">'+hi(snippet(m._disp,raw),terms)+'</div></a>';
      }).join('');
      if(capped)html+='<div class="more">Nur die ersten '+MAX+' Treffer werden angezeigt \\u2013 Suche verfeinern f\\u00fcr genauere Ergebnisse.</div>';
    }
    out.innerHTML=html;
    hint.textContent=msgHits.length+(capped?'+':'')+' Treffer';
  }

  var timer;
  q.addEventListener('input',function(){
    clearTimeout(timer);
    timer=setTimeout(function(){
      var v=q.value.trim();
      if(!v){renderDefault();}else{renderResults(v);}
    },120);
  });

  function rerender(){var v=q.value.trim(); if(!v)renderDefault(); else renderResults(v); mBadge();}

  // Markier-Buttons (Chat in der Tabelle, Nachricht in Suchtreffern)
  document.addEventListener('click',function(e){
    var t=e.target;
    var cb=t.closest?t.closest('.markchat'):null;
    if(cb){
      e.preventDefault();
      var v=mLoad(), d=cb.getAttribute('data-dir');
      if(v.c[d])delete v.c[d]; else v.c[d]=1;
      mSave(v); rerender();
      return;
    }
    var mb=t.closest?t.closest('.markmsg'):null;
    if(mb){
      e.preventDefault(); e.stopPropagation();
      var v2=mLoad(), k=mb.getAttribute('data-key');
      if(v2.m[k])delete v2.m[k]; else v2.m[k]=1;
      mSave(v2); rerender();
    }
  });
  window.addEventListener('storage',rerender);
  window.addEventListener('focus',mBadge);

  renderDefault();
  mBadge();
})();
</script>`;

// opts.walBericht: Link auf wal-bericht.html (USB-Weg mit Root).
function writeIndexHtml(entries, opts = {}) {
    const data = buildSearchData(entries);
    // JSON sicher einbetten: '<' neutralisieren, damit '</script>' in einem
    // Nachrichtentext das eingebettete Skript nicht vorzeitig beendet.
    const json = JSON.stringify(data).replace(/</g, '\\u003c');

    const totalMsg = entries.reduce((s, e) => s + e.messages, 0);
    const totalMedia = entries.reduce((s, e) => s + e.media, 0);
    const groups = entries.filter((e) => e.isGroup).length;

    const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp-Backup</title><style>${INDEX_CSS}</style></head><body>
<div class="top">
  <h1>WhatsApp-Backup</h1>
  <div class="sub">Stand: ${escapeHtml(new Date().toLocaleString('de-DE'))} &middot; ${entries.length} Chats (${groups} Gruppen) &middot; ${totalMsg} Nachrichten &middot; ${totalMedia} Medien &middot; <a href="dokumentation.html">Technische Doku</a> &middot; ${opts.walBericht ? '<a href="wal-bericht.html">WAL-Bericht</a> &middot; ' : ''}<a class="evlink" href="beweise.html">⚖️ Beweise (<span id="bcount">0</span>)</a></div>
  <div class="searchbar">
    <input type="search" id="q" placeholder="Chats und Nachrichteninhalte durchsuchen ..." autocomplete="off" autofocus>
    <span class="hint" id="hint"></span>
  </div>
</div>
<div class="wrap"><div id="results"></div></div>
<script>window.SEARCH_DATA = ${json};window.BACKUP_ID=${JSON.stringify(BACKUP_ID).replace(/</g, '\\u003c')};</script>
${INDEX_JS}
</body></html>`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), html);
}

// -------- Beweise-Seite (beweise.html) ---------------------------------------
//
// Zeigt alle als Beweis markierten Chats und Einzelnachrichten (Markierung
// erfolgt in chat.html und index.html, gespeichert im localStorage). Einzel-
// nachrichten immer mit Herkunft (Chat, Datum, Absender, Position). Über den
// Export-Knopf wird die Seite samt technischer Dokumentation gedruckt - im
// Druckdialog "Als PDF speichern" wählen.

const EVID_CSS = `
*{box-sizing:border-box;}
body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f0f2f5;color:#111b21;line-height:1.5;}
.top{background:#075e54;color:#fff;padding:16px 24px;}
.top h1{margin:0;font-size:1.25em;}
.top .sub{font-size:.85em;color:#c7f0e4;margin-top:4px;}
.top a{color:#a7f3d0;}
.toolbar{margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.toolbar button{border:none;border-radius:18px;padding:9px 16px;font-weight:600;cursor:pointer;}
#pdf{background:#ffd54d;color:#5b4300;}
#pdf:hover{background:#f5c832;}
#clear{background:#e9edef;color:#111b21;}
.toolbar .hinweis{font-size:.8em;color:#c7f0e4;}
.wrap{max-width:900px;margin:20px auto;padding:0 16px 48px;}
h2{color:#075e54;border-bottom:2px solid #d9e5e0;padding-bottom:4px;margin-top:32px;}
.chatblock,.msgcard{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);margin:14px 0;padding:14px 18px;page-break-inside:avoid;}
.chatblock h3{margin:0 0 4px;color:#075e54;}
.provenance{font-size:.82em;color:#54656f;margin-bottom:8px;border-left:3px solid #e2b93b;padding-left:8px;}
.provenance b{color:#075e54;}
.eline{padding:5px 0;border-bottom:1px solid #f2f4f5;font-size:.95em;word-break:break-word;white-space:pre-wrap;}
.eline:last-child{border-bottom:none;}
.eline .ed{color:#8696a0;font-size:.85em;margin-right:8px;}
.eline .es{color:#075e54;}
.content{white-space:pre-wrap;word-break:break-word;}
img.evmedia{max-width:100%;max-height:420px;border-radius:6px;display:block;margin:6px 0;}
video.evmedia,audio.evmedia{max-width:100%;display:block;margin:6px 0;}
.cap{font-size:.78em;color:#54656f;}
.badge{display:inline-block;font-size:.72em;font-weight:700;padding:1px 7px;border-radius:10px;margin-right:6px;}
.badge.g{background:#e7f5ee;color:#0a7a4f;}
.badge.c{background:#eef1f4;color:#54656f;}
.unmark{float:right;border:none;background:#f6d7d2;color:#7a2216;border-radius:12px;padding:3px 10px;font-size:.78em;cursor:pointer;}
.empty{background:#fff;border-radius:8px;padding:22px;color:#54656f;box-shadow:0 1px 3px rgba(0,0,0,.12);}
#cover{display:none;}
details#doku{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);margin:26px 0;padding:12px 18px;}
details#doku summary{cursor:pointer;font-weight:700;color:#075e54;}
details#doku h2{margin-top:22px;}
details#doku table{border-collapse:collapse;width:100%;}
details#doku th,details#doku td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;}
details#doku th{background:#075e54;color:#fff;}
details#doku pre{background:#1f2c33;color:#e9edef;border-radius:8px;padding:12px 14px;overflow-x:auto;}
details#doku code{background:#e9edef;border-radius:4px;padding:1px 4px;}
details#doku pre code{background:none;}
details#doku blockquote{background:#fff8e6;border-left:4px solid #e2b93b;margin:12px 0;padding:8px 12px;}
.kontobox{border:2px solid #075e54;border-radius:10px;padding:12px 16px;margin:14px 0;}
.kontobox h2{border:none;margin:0 0 8px;}
.kontobox th{background:#eef5f2 !important;color:#075e54 !important;width:220px;}
@media print{
  body{background:#fff;}
  .top{position:static;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .noprint,.toolbar,.unmark{display:none !important;}
  #cover{display:block;background:#fff;border:1px solid #ccc;border-radius:8px;padding:14px 18px;margin:14px 0;}
  .chatblock,.msgcard{box-shadow:none;border:1px solid #ddd;}
  details#doku{box-shadow:none;border:1px solid #ddd;page-break-before:always;}
  details#doku summary{display:none;}
  a{color:#111b21;text-decoration:none;}
}
`;

const EVID_JS = `<script>
(function(){
  var DATA=window.EVID||[], KEY='wab:marks:'+(window.BACKUP_ID||'');
  var byDir={}; DATA.forEach(function(ch){byDir[ch.dir]=ch;});
  var TL={image:'Bild',video:'Video',ptt:'Sprachnachricht',audio:'Audio',document:'Dokument',sticker:'Sticker'};
  function esc(s){return (s||'').replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  function load(){try{var v=JSON.parse(localStorage.getItem(KEY));return (v&&v.c&&v.m)?v:{c:{},m:{}};}catch(e){return {c:{},m:{}};}}
  function save(v){try{localStorage.setItem(KEY,JSON.stringify(v));}catch(e){}}
  function badge(g){return '<span class="badge '+(g?'g':'c')+'">'+(g?'Gruppe':'Chat')+'</span>';}
  function mediaHtml(dir,m){
    if(!m.mf)return '';
    var src=encodeURIComponent(dir)+'/media/'+encodeURIComponent(m.mf);
    var mm=m.mm||'';
    if(mm.indexOf('image/')===0)return '<img class="evmedia" src="'+src+'"><div class="cap">Bilddatei: '+esc(dir)+'/media/'+esc(m.mf)+'</div>';
    if(mm.indexOf('video/')===0)return '<video class="evmedia" src="'+src+'" controls preload="metadata"></video><div class="cap">Videodatei: '+esc(dir)+'/media/'+esc(m.mf)+' (im PDF nicht abspielbar)</div>';
    if(mm.indexOf('audio/')===0)return '<audio class="evmedia" src="'+src+'" controls preload="metadata"></audio><div class="cap">Audiodatei: '+esc(dir)+'/media/'+esc(m.mf)+' (im PDF nicht abspielbar)</div>';
    return '<div class="cap">\\uD83D\\uDCCE Datei: <a href="'+src+'" target="_blank">'+esc(m.mf)+'</a></div>';
  }
  function lineHtml(dir,m){
    var txt=m.b?esc(m.b):('['+(TL[m.t]||m.t)+']');
    return '<div class="eline"><span class="ed">'+esc(m.d)+'</span><b class="es">'+esc(m.s)+':</b> '+txt+mediaHtml(dir,m)+'</div>';
  }
  function render(){
    var v=load();
    var chatDirs=DATA.filter(function(ch){return v.c[ch.dir];}).map(function(ch){return ch.dir;});
    var msgKeys=Object.keys(v.m).sort();
    document.getElementById('cnt-chats').textContent=chatDirs.length;
    document.getElementById('cnt-msgs').textContent=msgKeys.length;
    document.getElementById('cover-count').textContent=chatDirs.length+' Chat(s), '+msgKeys.length+' Einzelnachricht(en)';

    var cs=document.getElementById('chatsec');
    if(!chatDirs.length){cs.innerHTML='<h2>Als Beweis markierte Chats (0)</h2><div class="empty">Keine ganzen Chats markiert. Markieren: in der <a href="index.html">Übersicht</a> auf das ⚖️ vor einem Chat klicken.</div>';}
    else{
      cs.innerHTML='<h2>Als Beweis markierte Chats ('+chatDirs.length+')</h2>'+chatDirs.map(function(dir){
        var ch=byDir[dir]; if(!ch)return '';
        return '<div class="chatblock"><button class="unmark" data-type="c" data-key="'+escAttr(dir)+'">Markierung entfernen</button>'+
          '<h3>'+badge(ch.g)+esc(ch.name)+'</h3>'+
          '<div class="provenance">Herkunft: Chat <b>'+esc(ch.name)+'</b> &middot; vollständig ('+ch.msgs.length+' Nachrichten) &middot; Ordner: '+esc(dir)+'/</div>'+
          ch.msgs.map(function(m){return lineHtml(dir,m);}).join('')+
          '</div>';
      }).join('');
    }

    var ms=document.getElementById('msgsec');
    if(!msgKeys.length){ms.innerHTML='<h2>Als Beweis markierte Einzelnachrichten (0)</h2><div class="empty">Keine Einzelnachrichten markiert. Markieren: im Chat mit der Maus über eine Nachricht fahren und ⚖️ anklicken (auch in Suchtreffern der Übersicht möglich).</div>';}
    else{
      ms.innerHTML='<h2>Als Beweis markierte Einzelnachrichten ('+msgKeys.length+')</h2>'+msgKeys.map(function(k){
        var p=k.lastIndexOf('/'); var dir=k.slice(0,p), idx=parseInt(k.slice(p+1),10);
        var ch=byDir[dir]; var m=ch&&ch.msgs[idx];
        if(!m)return '<div class="msgcard">Nachricht '+esc(k)+' nicht gefunden (anderes Backup?).</div>';
        return '<div class="msgcard"><button class="unmark" data-type="m" data-key="'+escAttr(k)+'">Markierung entfernen</button>'+
          '<div class="provenance">Herkunft: '+badge(ch.g)+'<b>'+esc(ch.name)+'</b> &middot; '+esc(m.d)+' &middot; Absender: <b>'+esc(m.s)+'</b> &middot; Position: Nachricht '+(idx+1)+' von '+ch.msgs.length+' &middot; <a class="noprint" href="'+escAttr(encodeURIComponent(dir))+'/chat.html#m'+idx+'" target="_blank">im Chat ansehen</a></div>'+
          '<div class="content">'+(m.b?esc(m.b):'['+(TL[m.t]||m.t)+']')+'</div>'+mediaHtml(dir,m)+
          '</div>';
      }).join('');
    }
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('.unmark'):null;
    if(!b)return;
    var v=load(), k=b.getAttribute('data-key');
    if(b.getAttribute('data-type')==='c')delete v.c[k]; else delete v.m[k];
    save(v); render();
  });
  document.getElementById('clear').addEventListener('click',function(){
    if(confirm('Wirklich alle Beweis-Markierungen dieses Backups aufheben?')){save({c:{},m:{}});render();}
  });
  document.getElementById('pdf').addEventListener('click',function(){window.print();});
  window.addEventListener('beforeprint',function(){
    document.getElementById('doku').open=true;
    document.getElementById('cover-export').textContent=new Date().toLocaleString('de-DE');
  });
  window.addEventListener('storage',render);
  window.addEventListener('focus',render);
  render();
})();
</script>`;

function writeEvidenceHtml(entries, meta) {
    // Vollständige Nachrichtendaten einbetten (inkl. Medien-Verweise), damit die
    // Seite Markierungen offline anzeigen kann.
    const data = entries.map((e) => ({
        dir: e.dir,
        name: e.name,
        g: e.isGroup ? 1 : 0,
        msgs: (e.records || []).map((r) => ({
            d: r.date, s: r.senderName, t: r.type,
            b: messagePlain(r), mf: r.mediaFile, mm: r.mediaMimetype
        }))
    }));
    const json = JSON.stringify(data).replace(/</g, '\\u003c');

    // Technische Doku als Anhang für den PDF-Export mit einbetten - mit dem
    // Konto-Infoblock ganz am Anfang.
    let docBody = '<p>(Technische Dokumentation nicht gefunden.)</p>';
    const mdPath = path.join(__dirname, 'DOKUMENTATION.md');
    if (fs.existsSync(mdPath)) {
        docBody = markdownToHtml(fs.readFileSync(mdPath, 'utf8').replace(/^# .*\r?\n/, '')).body;
    }
    docBody = accountInfoHtml(meta) + docBody;

    const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beweise - WhatsApp-Backup</title><style>${EVID_CSS}</style></head><body>
<div class="top">
  <h1>⚖️ Beweismittel</h1>
  <div class="sub">Backup ${escapeHtml(meta.backupId || '')} &middot; Konto ${escapeHtml(meta.konto || '?')} &middot; erstellt ${escapeHtml(meta.erstellt || '?')} &middot; <a href="index.html">&larr; zur Übersicht</a></div>
  <div class="toolbar noprint">
    <button id="pdf">Als PDF exportieren (inkl. Dokumentation)</button>
    <button id="clear">Alle Markierungen aufheben</button>
    <span class="hinweis">Im Druckdialog des Browsers „Als PDF speichern" wählen.</span>
  </div>
</div>
<div class="wrap">
  <div id="cover">
    <h2 style="margin-top:0;">Beweisexport aus WhatsApp-Backup</h2>
    <p><b>Backup-Ordner:</b> ${escapeHtml(meta.backupId || '')}<br>
    <b>WhatsApp-Konto:</b> ${escapeHtml(meta.konto || '?')}${meta.profilname ? ` (${escapeHtml(meta.profilname)})` : ''}<br>
    <b>Backup erstellt:</b> ${escapeHtml(meta.erstellt || '?')}<br>
    <b>Gesicherter Zeitraum:</b> ${escapeHtml(meta.zeitraum || 'gesamter verfügbarer Verlauf')}<br>
    <b>Dieser Export erstellt:</b> <span id="cover-export"></span><br>
    <b>Umfang:</b> <span id="cover-count"></span></p>
    <p>Die Unversehrtheit der zugrundeliegenden Dateien kann über die
    SHA-256-Prüfsummen in <code>manifest.json</code> nachgewiesen werden
    (Prüfung: <code>Backup-pruefen.bat</code>). Details im Anhang
    „Technische Dokumentation".</p>
  </div>
  <p class="noprint" style="color:#54656f;font-size:.9em;">Markiert: <b><span id="cnt-chats">0</span> Chat(s)</b> und <b><span id="cnt-msgs">0</span> Einzelnachricht(en)</b>. Markieren/Entfernen: ⚖️ in der <a href="index.html">Übersicht</a> (ganze Chats, Suchtreffer) oder direkt im Chat (einzelne Nachrichten).</p>
  <div id="chatsec"></div>
  <div id="msgsec"></div>
  <details id="doku"><summary>Technische Dokumentation (wird dem PDF als Anhang beigefügt)</summary>
${docBody}
  </details>
</div>
<script>window.EVID=${json};window.BACKUP_ID=${JSON.stringify(BACKUP_ID).replace(/</g, '\\u003c')};</script>
${EVID_JS}
</body></html>`;
    fs.writeFileSync(path.join(OUTPUT_DIR, 'beweise.html'), html);
}

// ---------------------------------------------------------------- Namensauflösung

// Löst Absender-IDs (auch neue "@lid"-Geräte-IDs) zu echten Namen auf. Nutzt die
// internen WhatsApp-Kontakt-Getter und die LID->Telefonnummer-Zuordnung. Ergebnis
// wird im übergebenen Cache (Map id -> Name/null) gespeichert, damit jede ID nur
// einmal aufgelöst wird.
async function resolveNames(client, ids, cache) {
    const missing = [...new Set(ids)].filter((id) => id && !cache.has(id));
    if (missing.length) {
        let resolved = {};
        try {
            resolved = await client.pupPage.evaluate((ids) => {
                const req = (m) => { try { return window.require(m); } catch (e) { return null; } };
                const Contact = (req('WAWebCollections') || {}).Contact;
                const WidFactory = req('WAWebWidFactory');
                const Getters = req('WAWebContactGetters');
                const ApiContact = req('WAWebApiContact');
                const out = {};
                for (const id of ids) {
                    let name = null, number = null;
                    try {
                        let wid = null;
                        try { wid = WidFactory && WidFactory.createWid(id); } catch (e) { /* egal */ }
                        let contact = wid && Contact ? Contact.get(wid) : null;
                        // "@lid"-IDs: über die zugehörige Telefonnummer-WID nachschlagen
                        if (!contact && wid && wid.isLid && wid.isLid() && ApiContact && ApiContact.getAlternateUserWid) {
                            const alt = ApiContact.getAlternateUserWid(wid);
                            if (alt && Contact) contact = Contact.get(alt);
                        }
                        if (contact && Getters) {
                            name = Getters.getName(contact) || Getters.getShortName(contact) || Getters.getPushname(contact) || null;
                            const pn = contact.phoneNumber || (contact.id && contact.id.user);
                            if (pn) number = String(pn).replace(/[^0-9]/g, '');
                        }
                    } catch (e) { /* einzelne ID ignorieren */ }
                    if (!number) {
                        const m = /^(\d+)@c\.us$/.exec(id);
                        if (m) number = m[1];
                    }
                    out[id] = { name, number };
                }
                return out;
            }, missing);
        } catch (e) { /* Auflösung fehlgeschlagen -> Fallbacks greifen später */ }
        for (const id of missing) {
            const r = resolved[id] || {};
            cache.set(id, r.name || (r.number ? '+' + r.number : null));
        }
    }
}

// Bester Anzeigename für einen Absender: gespeicherter Kontakt/Name > vom Sender
// selbst gesetzter Anzeigename (notifyName) > Telefonnummer > Roh-ID.
function displaySender(msg, senderId, chat, nameCache) {
    if (msg.fromMe) return 'Ich';
    const cached = nameCache.get(senderId);
    if (cached) return cached;
    if (!chat.isGroup && chat.name) return chat.name;
    if (msg._data && msg._data.notifyName) return msg._data.notifyName;
    const m = /^(\d+)@c\.us$/.exec(senderId || '');
    if (m) return '+' + m[1];
    return senderId || 'Unbekannt';
}

// ---------------------------------------------------------------- Backup-Logik

async function backupChat(client, chat, usedDirs, nameCache, onProgress, preparedMessages) {
    // eindeutigen Ordnernamen bestimmen (Chat-ID als Suffix bei Namenskollision)
    let dirName = sanitizeName(chat.name || chat.id.user);
    if (usedDirs.has(dirName.toLowerCase())) {
        dirName = `${dirName}_${sanitizeName(chat.id.user)}`;
    }
    usedDirs.add(dirName.toLowerCase());

    const chatDir = path.join(OUTPUT_DIR, dirName);
    const mediaDir = path.join(chatDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const { selectMessages } = require('./web-history');
    let messages = selectMessages(preparedMessages, MESSAGE_LIMIT, SINCE_TS);

    // Namen für diesen Chat vorab auflösen: Absender + von Gruppen-Ereignissen
    // betroffene Teilnehmer (add/remove/promote ...).
    const idsToResolve = [];
    for (const m of messages) {
        if (!m.fromMe) idsToResolve.push(m.author || m.from);
        if (m.type === 'gp2') {
            const d = m._data || {};
            if (m.author) idsToResolve.push(serializedId(m.author) || m.author);
            if (Array.isArray(d.recipients)) {
                for (const r of d.recipients) idsToResolve.push(typeof r === 'object' ? serializedId(r) : r);
            }
        }
    }
    await resolveNames(client, idsToResolve.filter(Boolean), nameCache);

    const { isMediaMessage, downloadWebMedia, errorInfo } = require('./web-media');
    const mediaTotal = messages.filter(isMediaMessage).length;
    const records = [];
    let mediaCount = 0;
    let mediaFailed = 0;
    let mediaSeen = 0;

    for (const msg of messages) {
        // downloadMedia() der Bibliothek nutzt intern msg.id._serialized - nachrüsten,
        // falls die aktuelle WhatsApp-Web-Version stattdessen "$1" liefert.
        if (msg.id && !msg.id._serialized) {
            msg.id._serialized = serializedId(msg.id);
        }
        const senderId = msg.author || msg.from;
        const rec = {
            id: serializedId(msg.id),
            timestamp: msg.timestamp,
            date: fmtDate(msg.timestamp),
            fromMe: msg.fromMe,
            senderId: senderId,
            senderName: displaySender(msg, senderId, chat, nameCache),
            type: msg.type,
            body: msg.body || '',
            hasMedia: isMediaMessage(msg),
            mediaFile: null,
            mediaMimetype: null
        };

        // Sondertypen anreichern: Anrufe, Kontaktkarten, Gruppen-Ereignisse.
        if (msg.type === 'call_log') rec.call = extractCall(msg);
        if (msg.type === 'vcard' || msg.type === 'multi_vcard') rec.contacts = extractContacts(msg);
        if (msg.type === 'gp2') rec.group = extractGroupEvent(msg, nameCache);

        if (rec.hasMedia) {
            mediaSeen++;
            if (onProgress) onProgress({ messages: records.length, mediaSeen, mediaTotal, mediaDone: mediaCount });
            const baseName = `${new Date(msg.timestamp * 1000).toISOString().slice(0, 10)}_${msg.id.id}`;
            // schon vorhanden? (inkrementeller Lauf)
            const existing = fs.readdirSync(mediaDir).find((f) => f.startsWith(baseName));
            if (existing) {
                rec.mediaFile = existing;
                rec.mediaMimetype = msg._data?.mimetype || null;
                mediaCount++;
            } else {
                try {
                    const media = await downloadWebMedia(client, msg);
                    if (media && media.data) {
                        const ext = extForMime(media.mimetype, media.filename);
                        const fileName = `${baseName}.${ext}`;
                        fs.writeFileSync(path.join(mediaDir, fileName), Buffer.from(media.data, 'base64'));
                        rec.mediaFile = fileName;
                        rec.mediaMimetype = media.mimetype;
                        mediaCount++;
                    } else {
                        mediaFailed++;
                        rec.mediaError = { status: null, reason: 'Leere Mediendatei erhalten' };
                    }
                } catch (err) {
                    mediaFailed++;
                    rec.mediaError = errorInfo(err);
                    clearStatus();
                    console.warn(`Medium ${rec.id}: ${rec.mediaError.reason}`
                        + (rec.mediaError.status ? ` (HTTP ${rec.mediaError.status})` : ''));
                }
            }
        }

        records.push(rec);
    }

    records.sort((a, b) => a.timestamp - b.timestamp);

    fs.writeFileSync(
        path.join(chatDir, 'messages.json'),
        JSON.stringify({ chatName: chat.name, chatId: chat.id._serialized, isGroup: chat.isGroup, exportedAt: new Date().toISOString(), messages: records }, null, 2)
    );
    writeChatHtml(chatDir, chat.name || chat.id.user, records, chat.isGroup, dirName);

    return { dir: dirName, name: chat.name || chat.id.user, isGroup: chat.isGroup, messages: records.length, media: mediaCount, mediaFailed, records };
}

// Die Chat-Serialisierung der Bibliothek (getChatModel) stürzt bei aktuellen
// WhatsApp-Web-Versionen mit einem IndexedDB-Fehler ab, sobald sie die "letzte
// Nachricht" eines Chats auflösen will (Issue #5733) - und getChats() macht ein
// Promise.all, sodass ein einziger Chat alles abbrechen lässt. Wir ersetzen die
// Funktion zur Laufzeit durch eine defensive Variante: erst das Original
// versuchen, bei einem Fehler eine Minimal-Serialisierung ohne lastMessage
// liefern (fürs Backup egal, die Nachrichten werden separat komplett geladen).
async function patchChatSerialization(client) {
    await client.pupPage.evaluate(() => {
        if (window.WWebJS.__backupPatched) return;
        window.WWebJS.__backupPatched = true;
        const orig = window.WWebJS.getChatModel;
        window.WWebJS.getChatModel = async (chat, opts) => {
            if (!chat) return null;
            try {
                return await orig(chat, opts);
            } catch (e) {
                let model;
                try {
                    model = chat.serialize();
                } catch (e2) {
                    model = { id: chat.id, name: chat.formattedTitle || null, t: chat.t };
                }
                model.isGroup = !!chat.groupMetadata;
                model.isMuted = chat.mute && chat.mute.expiration !== 0;
                try { model.formattedTitle = chat.formattedTitle; } catch (e2) { /* egal */ }
                if (chat.groupMetadata) {
                    try {
                        model.groupMetadata = chat.groupMetadata.serialize();
                        model.isReadOnly = chat.groupMetadata.announce;
                    } catch (e2) { /* Gruppen-Metadaten sind verzichtbar */ }
                }
                model.lastMessage = null;
                delete model.msgs;
                delete model.msgUnsyncedButtonReplyMsgs;
                delete model.unsyncedButtonReplies;
                return model;
            }
        };
    });
}

// Falls getChats() trotz Patch scheitert: Chat-IDs direkt aus den Collections
// lesen und jeden Chat einzeln laden; defekte Chats überspringen.
async function getAllChats(client) {
    try {
        return await client.getChats();
    } catch (err) {
        console.warn(`getChats() fehlgeschlagen (${err.message}) - lade Chats einzeln...`);
    }

    const ids = await client.pupPage.evaluate(() =>
        window.require('WAWebCollections').Chat.getModelsArray().map((c) => c.id._serialized)
    );
    console.log(`${ids.length} Chat-IDs gefunden.`);

    const chats = [];
    const failed = [];
    for (const id of ids) {
        try {
            chats.push(await client.getChatById(id));
        } catch (e) {
            failed.push(id);
        }
    }
    if (failed.length) {
        console.warn(`${failed.length} Chats konnten nicht geladen werden und werden übersprungen:`);
        for (const id of failed) console.warn(`  - ${id}`);
    }
    return chats;
}

async function runBackup(client) {
    // Zielordner für diesen Lauf festlegen: eigener Unterordner pro Gerät/Konto.
    const account = (client.info && client.info.wid && client.info.wid.user) || 'unbekannt';
    const label = client.info && client.info.pushname ? sanitizeName(client.info.pushname) : null;
    const runDirName = [account, label, runTimestamp()].filter(Boolean).join('_');
    OUTPUT_DIR = path.join(BACKUP_ROOT, runDirName);
    BACKUP_ID = runDirName;
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`Sichere in neuen Ordner: ${OUTPUT_DIR}\n`);

    await patchChatSerialization(client);

    // Namens-Cache über alle Chats hinweg (id -> aufgelöster Name/null)
    const nameCache = new Map();
    // Eigene Kontakte vorab in den Cache laden (schnelle Namensauflösung)
    console.log('Lade Kontaktliste...');
    try {
        const contacts = await client.getContacts();
        for (const c of contacts) {
            const name = c.name || c.pushname;
            const id = serializedId(c.id);
            if (name && id && !nameCache.has(id)) nameCache.set(id, name);
        }
    } catch (err) {
        console.warn('Kontakte konnten nicht geladen werden:', err.message);
    }

    console.log('Lade Chat-Liste...');
    let chats = await getAllChats(client);
    // Systemeintrag "0@c.us" (WhatsApp-Status/Platzhalter) aussortieren
    chats = chats.filter((c) => c && c.id && c.id._serialized !== '0@c.us');
    const totalAvailable = chats.length;
    console.log(`${totalAvailable} Chats verfügbar.`);

    if (!interactiveSelect) {
        // Nicht-interaktiv: --alle = alle, --chats N = erste N.
        if (chatsArgGiven && CHAT_LIMIT > 0 && chats.length > CHAT_LIMIT) {
            chats = chats.slice(0, CHAT_LIMIT);
        }
    } else {
        // Bevorzugt grafische Auswahl im vorhandenen Browser, sonst Konsole.
        try {
            const res = await selectChatsGui(client, chats);
            if (res.cancelled) {
                console.log('Auswahl abgebrochen – es wurde nichts gesichert.');
                return;
            }
            chats = res.chats;
            if (!limitArgGiven) MESSAGE_LIMIT = res.limit;
            // Stichtag aus dem Auswahlfenster übernehmen (überschreibt --seit nur,
            // wenn dort etwas eingetragen wurde).
            if (res.since) SINCE_TS = parseSince(res.since) || SINCE_TS;
        } catch (err) {
            console.warn(`Auswahlfenster nicht verfügbar (${err.message}) – nutze Konsolenauswahl.`);
            if (process.stdin.isTTY) {
                chats = await selectChats(chats);
            } else {
                console.log('Kein Terminal – sichere alle Chats.');
            }
        }
    }

    if (!chats.length) {
        console.log('Keine Chats ausgewählt – nichts zu sichern.');
        return;
    }

    console.log(`Zu sichern: ${chats.length} von ${totalAvailable} Chats`
        + `, ${limitLabel(effectiveMsgLimit())} Nachrichten pro Chat.`);
    console.log(`Zeitraum: ${sinceLabel(SINCE_TS)}.\n`);

    console.log('Ladephase: Chats automatisch bis zur ältesten verfügbaren Nachricht hochscrollen.');
    console.log('Der Export beginnt erst nach der Ladephase aller ausgewählten Chats.');
    const { prepareHistories } = require('./web-history');
    const histories = await prepareHistories(client, chats, (chat, i, p) => {
        const date = p.oldest ? new Date(p.oldest * 1000).toLocaleString('de-DE') : 'noch keine';
        writeStatus(`[Laden ${i + 1}/${chats.length}] ${chat.name || chat.id.user}: `
            + `${p.messages} Nachr., älteste: ${date}, Warteversuche: ${p.idle}/5`);
    });
    try {
        clearStatus();
        fs.writeFileSync(path.join(OUTPUT_DIR, 'history-ladebericht.json'),
            JSON.stringify({ created: new Date().toISOString(), chats: histories.reports }, null, 2));
        for (const report of histories.reports) {
            console.log(`${report.name}: ${report.messages} Nachrichten vorgeladen. ${report.note}`);
            for (const warning of report.warnings) console.warn('  Hinweis: ' + warning);
        }
        console.log('\nLadephase abgeschlossen. Starte Export ...');
        const { Message } = require('whatsapp-web.js');

        const usedDirs = new Set();
        const summary = [];
        const total = chats.length;

        for (let i = 0; i < total; i++) {
            const chat = chats[i];
            const label = chat.name || chat.id.user;
            const head = `[${i + 1}/${total}] ${progressBar(i / total)} `;

            const onProgress = (p) => {
                const mediaPart = p.mediaTotal
                    ? `  Medien ${p.mediaSeen}/${p.mediaTotal}` : '';
                writeStatus(`${head}${label}  ${p.messages} Nachr.${mediaPart}`);
            };
            onProgress({ messages: 0, mediaSeen: 0, mediaTotal: 0, mediaDone: 0 });

            try {
                const messages = histories.read(chat.id._serialized).map((data) => new Message(client, data));
                const result = await backupChat(client, chat, usedDirs, nameCache, onProgress, messages);
                summary.push(result);
                clearStatus();
                const kind = result.isGroup ? 'Gruppe' : 'Chat';
                const failNote = result.mediaFailed ? `, ${result.mediaFailed} Medien n. verfügbar` : '';
                console.log(`[${i + 1}/${total}] ${label} (${kind}): `
                    + `${result.messages} Nachrichten, ${result.media} Medien${failNote}`);
            } catch (err) {
                clearStatus();
                console.log(`[${i + 1}/${total}] ${label}: FEHLER: ${err.message}`);
            }
        }

        summary.sort((a, b) => a.name.localeCompare(b.name, 'de'));
        writeIndexHtml(summary);

        const totalMsg = summary.reduce((s, e) => s + e.messages, 0);
        const totalMedia = summary.reduce((s, e) => s + e.media, 0);
        const totalGroups = summary.filter((e) => e.isGroup).length;
        const mediaErrors = summary.flatMap((entry) => entry.records.filter((r) => r.mediaError)
            .map((r) => ({ chat: entry.dir,
                messageId: r.id, type: r.type, ...r.mediaError })));
        if (mediaErrors.length) {
            fs.writeFileSync(path.join(OUTPUT_DIR, 'media-fehler.json'), JSON.stringify(mediaErrors, null, 2));
            console.warn(`${mediaErrors.length} Medien fehlen. Gründe stehen in media-fehler.json und messages.json.`);
        }
        console.log(`\n${progressBar(1)} 100%`);
        console.log(`Fertig: ${summary.length} Chats (davon ${totalGroups} Gruppen), `
            + `${totalMsg} Nachrichten, ${totalMedia} Mediendateien.`);

        // Rahmendaten des Kontos für Doku-Infoblock und Beweise-Deckblatt sammeln.
        let waWebVersion = null;
        try { waWebVersion = await client.getWWebVersion(); } catch (e) { /* optional */ }
        const docMeta = {
            backupId: BACKUP_ID,
            konto: account,
            profilname: (client.info && client.info.pushname) || null,
            plattform: (client.info && client.info.platform) || null,
            erstellt: new Date().toLocaleString('de-DE'),
            zeitraum: SINCE_TS
                ? `${new Date(SINCE_TS * 1000).toLocaleString('de-DE')} bis ${new Date().toLocaleString('de-DE')}`
                : null,
            chats: summary.length,
            gruppen: totalGroups,
            nachrichten: totalMsg,
            medien: totalMedia,
            waWebVersion
        };

        // Technische Doku als formatierte HTML-Seite mit ins Backup legen.
        if (writeDocumentationHtml(OUTPUT_DIR, docMeta)) {
            console.log('Technische Doku beigelegt: dokumentation.html');
        }

        // Beweise-Seite (Markieren + PDF-Export) mit ins Backup legen.
        writeEvidenceHtml(summary, docMeta);
        console.log('Beweise-Seite beigelegt: beweise.html');

        // Integritäts-Manifest: SHA-256 aller Dateien festhalten.
        process.stdout.write('Erstelle Prüfsummen (manifest.json) ... ');
        const manifest = writeManifest(OUTPUT_DIR, {
            konto: account,
            profilname: client.info && client.info.pushname || null,
            chats: summary.length,
            nachrichten: totalMsg,
            medien: totalMedia
        });
        console.log(`${manifest.dateien} Dateien, ${(manifest.gesamtGroesseBytes / 1048576).toFixed(1)} MB.`);
        console.log('Später prüfen mit: Backup-pruefen.bat  (oder: node backup.js --pruefen)');

        console.log(`\nBackup liegt in: ${OUTPUT_DIR}`);
        console.log(`Übersicht öffnen: ${path.join(OUTPUT_DIR, 'index.html')}`);

        console.log('\n════════════════════════════════════════════════════════════');
        console.log('  WICHTIG: Verknüpftes Gerät wieder trennen!');
        console.log('  Handy: WhatsApp > Einstellungen > Verknüpfte Geräte');
        console.log('  > diesen Eintrag antippen > Abmelden');
        console.log('════════════════════════════════════════════════════════════');
    } finally { histories.cleanup(); }
}

// ---------------------------------------------------------------- Start

// WhatsApp Web lädt die Seite nach dem Login gern mitten in der Initialisierung neu;
// die Bibliothek wirft dann eine unbehandelte Promise-Rejection, injiziert sich beim
// nächsten Seitenaufbau aber selbst neu. Abfangen statt abstürzen.
process.on('unhandledRejection', (err) => {
    console.warn(`Hinweis: interner Fehler abgefangen (${err && err.message}) - warte auf Neuversuch...`);
});

// Watchdog: Wenn nach 5 Minuten weder QR-Code gescannt noch "ready" erreicht ist,
// sauber beenden, statt ewig zu hängen. Jeder neue QR-Code setzt den Timer zurück.
let watchdog;
function resetWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
        console.error('\nZeitüberschreitung: WhatsApp Web wurde nicht bereit. Bitte erneut starten.');
        process.exit(1);
    }, 5 * 60 * 1000);
}

async function main() {
    // Prüfmodus: "node backup.js --pruefen [ordner]" - kein Browser nötig.
    const pi = process.argv.indexOf('--pruefen');
    if (pi !== -1) {
        let dir = process.argv[pi + 1] && !process.argv[pi + 1].startsWith('--') ? process.argv[pi + 1] : null;
        if (!dir) {
            dir = newestRunDir();
            if (!dir) { console.error('Kein Backup-Ordner unter backup/ gefunden.'); process.exit(2); }
            console.log('(kein Ordner angegeben - prüfe das neueste Backup)');
        }
        process.exit(runVerify(path.resolve(dir)) ? 0 : 1);
    }

    if (!require('./web-dependencies').ensureWebDependencies()) { process.exitCode = 1; return; }
    const { Client } = require('whatsapp-web.js');
    const qrcode = require('qrcode-terminal');
    console.log('Starte Browser mit WhatsApp Web...');
    if (interactiveSelect) {
        console.log('Chats und Nachrichten-Limit wählst du nach dem Anmelden im Auswahlfenster.');
    } else {
        const chatPlan = forceAll ? 'alle Chats' : `${limitLabel(CHAT_LIMIT)} Chats`;
        console.log(`Geplant: ${chatPlan}, ${limitLabel(effectiveMsgLimit())} Nachrichten pro Chat.`);
    }

    // Bewusst KEINE gespeicherte Sitzung (NoAuth ist Standard): Bei jedem Start
    // wird ein QR-Code angezeigt, damit sich jedes Mal ein Gerät anmelden kann.
    const client = new Client({
        puppeteer: {
            headless: false,
            ...(process.env.PUPPETEER_EXECUTABLE_PATH
                ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
            args: ['--no-default-browser-check', '--disable-extensions']
        }
    });

    client.on('qr', (qr) => {
        resetWatchdog(); // solange QR-Codes kommen, wartet jemand auf den Scan
        console.log('\nBitte anmelden: QR-Code im Browser-Fenster scannen');
        console.log('(Handy: WhatsApp > Einstellungen > Verknüpfte Geräte > Gerät hinzufügen)\n');
        qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => console.log('Angemeldet.'));
    client.on('auth_failure', (msg) => {
        console.error('Anmeldung fehlgeschlagen:', msg);
        process.exit(1);
    });

    // WhatsApp Web kann "ready" mehrfach auslösen (Re-Injection nach Reload).
    // Nur der erste Durchlauf darf sichern, sonst öffnen sich mehrere
    // Auswahlfenster und es entstehen doppelte Backup-Ordner.
    let backupStarted = false;
    client.on('ready', async () => {
        if (backupStarted) return;
        backupStarted = true;
        clearTimeout(watchdog);
        console.log(`\nWhatsApp Web ist bereit. Warte ${SYNC_WAIT_SECONDS} Sekunden auf Synchronisierung der Historie...`);
        console.log('(Tipp: WhatsApp auf dem Handy geöffnet lassen; mit --wait <Sekunden> länger warten)');
        await new Promise((r) => setTimeout(r, SYNC_WAIT_SECONDS * 1000));
        let exitCode = 0;
        try {
            await runBackup(client);
        } catch (err) {
            exitCode = 1;
            console.error('Backup fehlgeschlagen:', err);
        } finally {
            await client.destroy();
            process.exit(exitCode);
        }
    });

    resetWatchdog();
    client.initialize();
}

// Nur starten, wenn direkt aufgerufen (nicht beim Einbinden als Modul/Test).
if (require.main === module) {
    main();
}

// Für Tests: reine HTML-Erzeugung und Auswahl-Logik ohne WhatsApp-Verbindung.
// Saubere API für andere Backup-Quellen (z. B. usb-backup.js), die dieselbe
// Ausgabe (chat.html, index.html, beweise.html, Doku, Manifest) erzeugen wollen.
module.exports = {
    writeIndexHtml, writeChatHtml, writeEvidenceHtml,
    writeDocumentationHtml, writeManifest, verifyBackup,
    setOutputDir: (d) => { OUTPUT_DIR = d; },
    setBackupId: (id) => { BACKUP_ID = id; },
    _test: { backupChat, parseSelection, selectChats, buildSelectGuiHtml, specialBubbleHtml, messagePlain, parseVcard, groupEventText, writeManifest, verifyBackup, markdownToHtml, writeDocumentationHtml, writeEvidenceHtml, setBackupId: (id) => { BACKUP_ID = id; } }
};
