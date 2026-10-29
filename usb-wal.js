/**
 * Forensische Auswertung des SQLite-Write-Ahead-Logs (WAL) der Live-Datenbanken.
 *
 * Beim Root-Abzug wird die Datenbank samt -wal gelesen und das Log in die lokale
 * Kopie eingearbeitet. Damit das nachvollziehbar bleibt, hält dieses Modul fest,
 *   1. wie das Log aufgebaut war (Kopf, Frames, Prüfsummenkette nach SQLite-
 *      Spezifikation https://www.sqlite.org/fileformat2.html#walformat),
 *   2. welche Seiten/Tabellen es betraf und
 *   3. was es inhaltlich änderte: Vergleich "Hauptdatei allein" (Stand A)
 *      gegen "Hauptdatei + Log" (Stand B), je Tabelle neue/geänderte/gelöschte
 *      Zeilen (per rowid und vollständigem Zeilenvergleich).
 * Veraltete Frames (anderes Salt / gebrochene Prüfsumme) gehen nicht in Stand B
 * ein; sie bleiben in der Rohdatei erhalten und werden gezählt und benannt.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DETAIL_LIMIT = 500; // max. Detailzeilen je Tabelle und Kategorie

// ---------------------------------------------------------------- Log-Aufbau

// SQLite-WAL-Prüfsumme über buf[start, end), fortgesetzt ab (s0, s1).
function walChecksum(buf, start, end, s0, s1, bigEndian) {
    for (let i = start; i < end; i += 8) {
        const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
        const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
        s0 = (s0 + x0 + s1) >>> 0;
        s1 = (s1 + x1 + s0) >>> 0;
    }
    return [s0, s1];
}

// Zerlegt eine -wal-Datei. Jeder Frame bekommt einen Status:
//   festgeschrieben        - gültig und Teil einer abgeschlossenen Transaktion (geht in Stand B ein)
//   nicht festgeschrieben  - gültig, aber nach dem letzten Commit (SQLite ignoriert ihn)
//   veraltet               - Salt/Prüfsumme passt nicht: Rest einer früheren Log-Runde
function parseWal(buf) {
    if (!buf || buf.length < 32) return { gueltig: false, grund: buf && buf.length ? 'kürzer als der 32-Byte-Kopf' : 'leer', frames: [] };
    const magic = buf.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return { gueltig: false, grund: 'keine WAL-Kennung', frames: [] };
    const bigEndian = magic === 0x377f0683;
    const header = {
        kennung: '0x' + magic.toString(16),
        byteReihenfolgePruefsumme: bigEndian ? 'big-endian' : 'little-endian',
        formatVersion: buf.readUInt32BE(4),
        seitengroesse: buf.readUInt32BE(8),
        checkpointZaehler: buf.readUInt32BE(12),
        salt1: buf.readUInt32BE(16),
        salt2: buf.readUInt32BE(20)
    };
    let [s0, s1] = walChecksum(buf, 0, 24, 0, 0, bigEndian);
    header.kopfPruefsummeOk = s0 === buf.readUInt32BE(24) && s1 === buf.readUInt32BE(28);

    const ps = header.seitengroesse;
    const frameSize = 24 + ps;
    const count = ps ? Math.floor((buf.length - 32) / frameSize) : 0;
    const frames = [];
    let chainOk = header.kopfPruefsummeOk, lastCommit = -1;
    for (let i = 0; i < count; i++) {
        const o = 32 + i * frameSize;
        const f = {
            nr: i + 1,
            offset: o, // Byte-Position des Frame-Kopfs in der -wal-Datei
            seite: buf.readUInt32BE(o),
            commitGroesse: buf.readUInt32BE(o + 4), // != 0 -> Commit-Frame
            saltPasst: buf.readUInt32BE(o + 8) === header.salt1 && buf.readUInt32BE(o + 12) === header.salt2
        };
        if (chainOk && f.saltPasst) {
            [s0, s1] = walChecksum(buf, o, o + 8, s0, s1, bigEndian);
            [s0, s1] = walChecksum(buf, o + 24, o + frameSize, s0, s1, bigEndian);
            chainOk = s0 === buf.readUInt32BE(o + 16) && s1 === buf.readUInt32BE(o + 20);
        } else chainOk = false;
        f.kette = chainOk;
        if (chainOk && f.commitGroesse) lastCommit = i;
        frames.push(f);
    }
    for (const f of frames) {
        f.status = !f.kette ? 'veraltet' : (f.nr - 1 <= lastCommit ? 'festgeschrieben' : 'nicht festgeschrieben');
    }
    const by = (s) => frames.filter((f) => f.status === s).length;
    return {
        gueltig: true, header, frames,
        rest: buf.length - 32 - count * frameSize, // angehängte Bytes ohne vollen Frame
        stat: {
            frames: frames.length,
            festgeschrieben: by('festgeschrieben'),
            nichtFestgeschrieben: by('nicht festgeschrieben'),
            veraltet: by('veraltet'),
            transaktionen: frames.filter((f) => f.status === 'festgeschrieben' && f.commitGroesse).length,
            seitenzahlNachLetztemCommit: lastCommit >= 0 ? frames[lastCommit].commitGroesse : null
        }
    };
}

// ---------------------------------------------------------------- Inhaltsvergleich

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const qs = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Wert JSON-tauglich machen (BLOBs nur als Länge + Hash).
function plain(v) {
    if (v instanceof Uint8Array) return `<BLOB ${v.length} Byte, sha256 ${crypto.createHash('sha256').update(v).digest('hex').slice(0, 16)}…>`;
    if (typeof v === 'bigint') return v.toString();
    return v;
}
function plainRow(row) {
    const o = {};
    for (const [k, v] of Object.entries(row || {})) if (k !== '__r') o[k] = plain(v);
    return o;
}

// Seite -> Tabelle (Indizes werden ihrer Tabelle zugeordnet), über dbstat.
function pageOwners(db, schema) {
    const owners = new Map();
    try {
        const tblOf = new Map(db.prepare(`SELECT name, tbl_name FROM ${schema}.sqlite_master`).all().map((r) => [r.name, r.tbl_name]));
        for (const r of db.prepare(`SELECT name, pageno FROM dbstat(${qs(schema)})`).all()) {
            owners.set(r.pageno, { objekt: r.name, tabelle: tblOf.get(r.name) || r.name });
        }
    } catch (e) { /* dbstat nicht verfügbar: Zuordnung bleibt leer */ }
    return owners;
}

// Vergleicht eine Tabelle zwischen main (Stand B) und alt (Stand A).
function diffTable(db, table) {
    const t = qi(table);
    const colsB = db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name);
    const colsA = db.prepare(`PRAGMA alt.table_info(${t})`).all().map((c) => c.name);
    const res = { tabelle: table, neu: 0, geaendert: 0, geloescht: 0, ids: { neu: [], geaendert: [], geloescht: [] }, details: { neu: [], geaendert: [], geloescht: [] } };
    if (!colsB.length && !colsA.length) return null;
    if (!colsA.length) res.hinweis = 'Tabelle existiert nur mit Log (im Log angelegt).';
    if (!colsB.length) res.hinweis = 'Tabelle existiert nur ohne Log (im Log gelöscht).';
    try {
        const common = colsB.filter((c) => colsA.includes(c));
        const sel = common.map(qi).join(', ');
        const idsB = colsB.length ? new Set(db.prepare(`SELECT rowid AS r FROM main.${t}`).all().map((r) => r.r)) : new Set();
        const idsA = colsA.length ? new Set(db.prepare(`SELECT rowid AS r FROM alt.${t}`).all().map((r) => r.r)) : new Set();
        let diffB = [];
        if (colsB.length && colsA.length) {
            diffB = db.prepare(`SELECT __r FROM (SELECT rowid AS __r, ${sel} FROM main.${t} EXCEPT SELECT rowid, ${sel} FROM alt.${t})`).all().map((r) => r.__r);
        } else if (colsB.length) diffB = [...idsB];
        for (const id of diffB) (idsA.has(id) ? res.ids.geaendert : res.ids.neu).push(id);
        for (const id of idsA) if (!idsB.has(id)) res.ids.geloescht.push(id);
        res.neu = res.ids.neu.length; res.geaendert = res.ids.geaendert.length; res.geloescht = res.ids.geloescht.length;

        const getB = colsB.length ? db.prepare(`SELECT * FROM main.${t} WHERE rowid = ?`) : null;
        const getA = colsA.length ? db.prepare(`SELECT * FROM alt.${t} WHERE rowid = ?`) : null;
        for (const id of res.ids.neu.slice(0, DETAIL_LIMIT)) res.details.neu.push({ rowid: id, zeile: plainRow(getB.get(id)) });
        for (const id of res.ids.geloescht.slice(0, DETAIL_LIMIT)) res.details.geloescht.push({ rowid: id, zeile: plainRow(getA.get(id)) });
        for (const id of res.ids.geaendert.slice(0, DETAIL_LIMIT)) {
            const vorher = plainRow(getA.get(id)), nachher = plainRow(getB.get(id));
            const spalten = common.filter((c) => JSON.stringify(vorher[c]) !== JSON.stringify(nachher[c]));
            res.details.geaendert.push({ rowid: id, spalten, vorher, nachher });
        }
    } catch (e) {
        res.hinweis = 'Zeilenvergleich nicht möglich (' + e.message + ') - z. B. Tabelle ohne rowid.';
    }
    return res;
}

// Nachrichten (msgstore) lesbar aufbereiten: Zeit, Chat, Richtung, Text.
function messageDetails(db, schema, ids, nameFor) {
    if (!ids.length) return [];
    const has = (tbl) => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(tbl);
    if (!has('message')) return [];
    const join = has('chat') && has('jid');
    const stmt = db.prepare(`SELECT m._id AS id, m.timestamp AS ts, m.from_me AS vonMir, m.message_type AS typ, m.text_data AS text
        ${join ? ', j.raw_string AS chat' : ''}
        FROM ${schema}.message m
        ${join ? `LEFT JOIN ${schema}.chat c ON c._id = m.chat_row_id LEFT JOIN ${schema}.jid j ON j._id = c.jid_row_id` : ''}
        WHERE m._id = ?`);
    return ids.slice(0, DETAIL_LIMIT).map((id) => {
        const r = stmt.get(id);
        if (!r) return { id };
        return {
            id: r.id,
            zeit: r.ts ? new Date(Number(r.ts)).toLocaleString('de-DE') : '',
            chat: r.chat ? (nameFor ? `${nameFor(r.chat)} (${r.chat})` : r.chat) : '',
            richtung: r.vonMir ? 'gesendet' : 'empfangen',
            typ: r.typ,
            text: r.text || ''
        };
    });
}

// ---------------------------------------------------------------- Gesamtanalyse

// rawDir enthält die unveränderten Dateien vom Handy (name, name-wal, name-shm).
// merged = Arbeitskopie mit eingearbeitetem Log (Stand B).
// files  = [{ name, bytes, sha256, mtime, mode, uid, gid }] aus dem tar-Strom.
function analyzeLive({ name, remoteDir, rawDir, merged, files, workDir, nameFor = null }) {
    const report = { datenbank: name, handyPfad: `${remoteDir}/${name}`, dateien: files, wal: null, seiten: [], tabellen: [], nachrichten: null };
    const walFile = path.join(rawDir, name + '-wal');
    if (!fs.existsSync(walFile) || fs.statSync(walFile).size === 0) {
        report.wal = { vorhanden: false };
        return report;
    }
    const wal = parseWal(fs.readFileSync(walFile));
    report.wal = { vorhanden: true, gueltig: wal.gueltig, grund: wal.grund, header: wal.header, stat: wal.stat, restBytes: wal.rest,
        frames: wal.frames.map(({ nr, offset, seite, commitGroesse, status }) => ({ nr, offset, seite, commitGroesse, status })) };
    if (!wal.gueltig) return report;

    // Stand A: Hauptdatei allein (Kopie ohne -wal/-shm).
    const aDir = path.join(workDir, 'stand-a-' + name);
    fs.mkdirSync(aDir, { recursive: true });
    const aPath = path.join(aDir, name);
    fs.copyFileSync(path.join(rawDir, name), aPath);

    const db = new DatabaseSync(merged);
    try {
        db.exec(`ATTACH DATABASE ${qs(aPath)} AS alt`);
        const ownB = pageOwners(db, 'main'), ownA = pageOwners(db, 'alt');

        // Seitenübersicht: je Seite Anzahl Frames je Status und Eigentümer.
        const pages = new Map();
        for (const f of wal.frames) {
            const p = pages.get(f.seite) || { seite: f.seite, festgeschrieben: 0, nichtFestgeschrieben: 0, veraltet: 0 };
            if (f.status === 'festgeschrieben') p.festgeschrieben++;
            else if (f.status === 'nicht festgeschrieben') p.nichtFestgeschrieben++;
            else p.veraltet++;
            pages.set(f.seite, p);
        }
        for (const p of pages.values()) {
            const o = p.seite === 1 ? { objekt: 'sqlite_master', tabelle: 'Datenbankkopf/Schema' } : (ownB.get(p.seite) || ownA.get(p.seite));
            p.gehoertZu = o ? (o.objekt === o.tabelle ? o.tabelle : `${o.tabelle} (${o.objekt})`) : 'frei/unbenutzt (Freiliste)';
            p.tabelle = o ? o.tabelle : null;
        }
        report.seiten = [...pages.values()].sort((a, b) => a.seite - b.seite);

        // Inhaltlich vergleichen: nur Tabellen, deren Seiten festgeschrieben im Log stehen.
        const touched = new Set(report.seiten.filter((p) => p.festgeschrieben && p.tabelle && p.tabelle !== 'Datenbankkopf/Schema').map((p) => p.tabelle));
        const schemaTouched = report.seiten.some((p) => p.seite === 1 && p.festgeschrieben);
        if (schemaTouched || report.seiten.some((p) => p.festgeschrieben && !p.tabelle)) {
            // Schema oder Freiliste betroffen: vorsichtshalber alle Tabellen vergleichen.
            for (const s of ['main', 'alt']) for (const r of db.prepare(`SELECT name FROM ${s}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all()) touched.add(r.name);
        }
        for (const table of [...touched].sort()) {
            const d = diffTable(db, table);
            if (d) report.tabellen.push(d);
        }
        const msg = report.tabellen.find((t) => t.tabelle === 'message');
        if (msg) {
            report.nachrichten = {
                neu: messageDetails(db, 'main', msg.ids.neu, nameFor),
                geaendert: msg.ids.geaendert.slice(0, DETAIL_LIMIT).map((id) => ({
                    vorher: messageDetails(db, 'alt', [id], nameFor)[0],
                    nachher: messageDetails(db, 'main', [id], nameFor)[0]
                })),
                geloescht: messageDetails(db, 'alt', msg.ids.geloescht, nameFor)
            };
        }
        db.exec('DETACH DATABASE alt');
    } finally { db.close(); }
    return report;
}

// Nachrichten-IDs, die ihren Stand erst durch das Log bekamen (für die Markierung im Export).
function walMessageIds(report) {
    const msg = report && report.tabellen.find((t) => t.tabelle === 'message');
    return { neu: new Set(msg ? msg.ids.neu : []), geaendert: new Set(msg ? msg.ids.geaendert : []) };
}

// Kurzfassung für Doku-Infoblock und Konsole.
function walSummary(reports) {
    return reports.map((r) => {
        if (!r.wal || !r.wal.vorhanden) return `${r.datenbank}: kein Log`;
        if (!r.wal.gueltig) return `${r.datenbank}: Log unlesbar (${r.wal.grund})`;
        const s = r.wal.stat;
        const t = r.tabellen.reduce((a, x) => ({ n: a.n + x.neu, g: a.g + x.geaendert, l: a.l + x.geloescht }), { n: 0, g: 0, l: 0 });
        return `${r.datenbank}: ${s.frames} Frames (${s.festgeschrieben} festgeschrieben in ${s.transaktionen} Transaktionen, `
            + `${s.nichtFestgeschrieben} nicht festgeschrieben, ${s.veraltet} veraltet); Zeilen durch das Log: `
            + `${t.n} neu, ${t.g} geändert, ${t.l} gelöscht`;
    }).join(' | ');
}

// ---------------------------------------------------------------- Bericht

const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
*{box-sizing:border-box;}
body{font-family:Segoe UI,Arial,sans-serif;margin:0;background:#f0f2f5;color:#111b21;line-height:1.5;}
.top{background:#075e54;color:#fff;padding:16px 24px;}
.top h1{margin:0;font-size:1.25em;}
.top .sub{font-size:.85em;color:#c7f0e4;margin-top:4px;}
.top a{color:#a7f3d0;}
.wrap{max-width:1100px;margin:20px auto;padding:0 16px 48px;}
h2{color:#075e54;border-bottom:2px solid #d9e5e0;padding-bottom:4px;margin-top:36px;}
h3{color:#075e54;margin:22px 0 6px;}
.box{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.12);padding:12px 16px;margin:12px 0;overflow-x:auto;}
table{border-collapse:collapse;width:100%;font-size:.9em;}
th,td{padding:5px 9px;border-bottom:1px solid #eee;text-align:left;vertical-align:top;}
th{background:#eef5f2;color:#075e54;}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
code,.mono{font-family:Consolas,monospace;font-size:.88em;word-break:break-all;}
.warn{background:#fff8e6;border-left:4px solid #e2b93b;padding:8px 12px;margin:10px 0;}
.del{background:#fdecea;}
.muted{color:#667781;}
details summary{cursor:pointer;color:#075e54;font-weight:600;}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:.85em;}
@media print{body{background:#fff;}.box{box-shadow:none;border:1px solid #ccc;}}
`;

function tableHtml(head, rows) {
    return `<table><tr>${head.map((h) => `<th${h.num ? ' class="num"' : ''}>${esc(h.t || h)}</th>`).join('')}</tr>${rows.join('')}</table>`;
}

function reportSectionHtml(r) {
    const out = [`<h2>${esc(r.datenbank)}</h2>`];
    out.push(`<div class="box"><b>Pfad am Handy:</b> <code>${esc(r.handyPfad)}</code>`);
    out.push(tableHtml(['Datei', { t: 'Bytes', num: true }, 'Zuletzt geändert (am Handy)', 'Rechte/Eigentümer', 'SHA-256 (wie vom Handy gelesen)'],
        r.dateien.map((f) => `<tr><td><code>rohdaten/${esc(f.name)}</code></td><td class="num">${f.bytes}</td><td>${esc(f.mtime)}</td><td class="mono">${esc(f.mode)} ${esc(f.uid)}:${esc(f.gid)}</td><td class="mono">${esc(f.sha256)}</td></tr>`)));
    out.push('</div>');

    if (!r.wal.vorhanden) { out.push('<p>Kein Write-Ahead-Log vorhanden bzw. leer - die Hauptdatei ist der vollständige Stand.</p>'); return out.join('\n'); }
    if (!r.wal.gueltig) { out.push(`<div class="warn">Log nicht auswertbar: ${esc(r.wal.grund)}. Die Rohdatei liegt unverändert in <code>rohdaten/</code>.</div>`); return out.join('\n'); }

    const h = r.wal.header, s = r.wal.stat;
    out.push('<h3>Aufbau des Logs</h3><div class="box">');
    out.push(tableHtml(['Angabe', 'Wert'], [
        ['Kennung / Prüfsummen-Byte-Reihenfolge', `${h.kennung} / ${h.byteReihenfolgePruefsumme}`],
        ['Format-Version', h.formatVersion],
        ['Seitengröße', `${h.seitengroesse} Byte`],
        ['Checkpoint-Sequenznummer', `${h.checkpointZaehler} (zählt, wie oft das Log nach einem Checkpoint neu begonnen wurde)`],
        ['Salt 1 / Salt 2', `${h.salt1} / ${h.salt2}`],
        ['Kopf-Prüfsumme', h.kopfPruefsummeOk ? 'korrekt' : 'FEHLERHAFT'],
        ['Frames gesamt', s.frames],
        ['festgeschrieben (in den Export eingeflossen)', `${s.festgeschrieben} in ${s.transaktionen} abgeschlossenen Transaktionen`],
        ['nicht festgeschrieben (von SQLite verworfen)', s.nichtFestgeschrieben],
        ['veraltet (Reste früherer Log-Runden, nicht im Export)', s.veraltet],
        ['Seitenzahl der Datenbank nach letztem Commit', s.seitenzahlNachLetztemCommit ?? '-'],
        ['Überzählige Bytes am Dateiende', r.wal.restBytes]
    ].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)));
    out.push('</div>');
    if (s.veraltet || s.nichtFestgeschrieben || r.wal.restBytes) {
        const rest = r.wal.restBytes ? ` Dazu kommen ${r.wal.restBytes} Byte am Dateiende (Rest eines unvollständigen Frames).` : '';
        out.push(`<div class="warn">${s.veraltet + s.nichtFestgeschrieben} Frames sind NICHT in den Export eingeflossen, weil SQLite sie verwirft.${rest} Sie können ältere oder gelöschte Inhalte enthalten und liegen unverändert in <code>rohdaten/${esc(r.datenbank)}-wal</code>, z. B. für eine Auswertung mit einem Forensik-Werkzeug (Frame-Nummern und Byte-Positionen unten und in <code>wal-bericht.json</code>).</div>`);
        const skipped = r.wal.frames.filter((f) => f.status !== 'festgeschrieben');
        out.push(`<details class="box"><summary>Nicht eingeflossene Frames (${skipped.length})</summary>${tableHtml(
            [{ t: 'Frame', num: true }, { t: 'Byte-Position', num: true }, { t: 'Seite', num: true }, 'Status'],
            skipped.map((f) => `<tr><td class="num">${f.nr}</td><td class="num">${f.offset}</td><td class="num">${f.seite}</td><td>${esc(f.status)}</td></tr>`))}</details>`);
    }

    out.push('<h3>Betroffene Seiten</h3><div class="box">');
    out.push(tableHtml([{ t: 'Seite', num: true }, 'gehört zu (Stand B, sonst Stand A)', { t: 'festgeschr.', num: true }, { t: 'nicht festgeschr.', num: true }, { t: 'veraltet', num: true }],
        r.seiten.map((p) => `<tr><td class="num">${p.seite}</td><td>${esc(p.gehoertZu)}</td><td class="num">${p.festgeschrieben}</td><td class="num">${p.nichtFestgeschrieben}</td><td class="num">${p.veraltet}</td></tr>`)));
    out.push('<p class="muted">Zuordnung über SQLite-dbstat. Bei veralteten Frames ist sie nur ein Hinweis: die Seite kann seitdem neu vergeben worden sein.</p></div>');

    out.push('<h3>Inhaltliche Änderungen durch das Log (Stand A → Stand B)</h3><div class="box">');
    if (!r.tabellen.length) out.push('<p>Keine Tabelle betroffen.</p>');
    else {
        out.push(tableHtml(['Tabelle', { t: 'neu', num: true }, { t: 'geändert', num: true }, { t: 'gelöscht', num: true }, 'Hinweis'],
            r.tabellen.map((t) => `<tr><td><code>${esc(t.tabelle)}</code></td><td class="num">${t.neu}</td><td class="num">${t.geaendert}</td><td class="num">${t.geloescht}</td><td>${esc(t.hinweis || '')}</td></tr>`)));
        for (const t of r.tabellen.filter((x) => x.neu + x.geaendert + x.geloescht)) {
            const rows = [
                ...t.details.neu.map((d) => `<tr><td>neu</td><td class="num">${d.rowid}</td><td><pre>${esc(JSON.stringify(d.zeile, null, 1))}</pre></td></tr>`),
                ...t.details.geaendert.map((d) => `<tr><td>geändert<br><span class="muted">${esc(d.spalten.join(', '))}</span></td><td class="num">${d.rowid}</td><td><pre>${esc(JSON.stringify(Object.fromEntries(d.spalten.map((c) => [c, { vorher: d.vorher[c], nachher: d.nachher[c] }])), null, 1))}</pre></td></tr>`),
                ...t.details.geloescht.map((d) => `<tr class="del"><td>gelöscht</td><td class="num">${d.rowid}</td><td><pre>${esc(JSON.stringify(d.zeile, null, 1))}</pre></td></tr>`)
            ];
            const capped = Math.max(t.neu, t.geaendert, t.geloescht) > DETAIL_LIMIT ? ` (je Kategorie die ersten ${DETAIL_LIMIT})` : '';
            out.push(`<details><summary>${esc(t.tabelle)}: Einzelzeilen${capped}</summary>${tableHtml(['Art', { t: 'rowid', num: true }, 'Inhalt'], rows)}</details>`);
        }
    }
    out.push('</div>');

    if (!r.nachrichten && r.datenbank === 'msgstore.db') {
        out.push('<h3>Nachrichten, die ihren Stand aus dem Log haben</h3><div class="box"><p><b>Keine.</b> Die Tabelle <code>message</code> hat keine festgeschriebene Seite im Log; alle exportierten Nachrichten standen bereits in der Hauptdatei.</p></div>');
    }
    if (r.nachrichten) {
        const n = r.nachrichten;
        const msgRow = (m, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td class="num">${esc(m.id)}</td><td>${esc(m.zeit)}</td><td>${esc(m.chat)}</td><td>${esc(m.richtung)}</td><td>${esc(m.typ)}</td><td><pre>${esc(m.text)}</pre></td></tr>`;
        const head = [{ t: 'ID', num: true }, 'Zeit', 'Chat', 'Richtung', 'Typ', 'Text'];
        out.push('<h3>Nachrichten, die ihren Stand aus dem Log haben</h3><div class="box">');
        out.push(`<p><b>${n.neu.length}</b> neu (nur im Log), <b>${n.geaendert.length}</b> geändert, <b>${n.geloescht.length}</b> gelöscht (in der Hauptdatei noch vorhanden, im aktuellen Stand nicht mehr - daher NICHT im Chat-Export, nur hier).</p>`);
        if (n.neu.length) out.push('<h3>Neu</h3>' + tableHtml(head, n.neu.map((m) => msgRow(m))));
        if (n.geaendert.length) out.push('<h3>Geändert (vorher / nachher)</h3>' + tableHtml(head, n.geaendert.flatMap((x) => [msgRow(x.vorher, 'del'), msgRow(x.nachher)])));
        if (n.geloescht.length) out.push('<h3>Gelöscht</h3>' + tableHtml(head, n.geloescht.map((m) => msgRow(m, 'del'))));
        out.push('</div>');
    }
    return out.join('\n');
}

function writeWalReport(outputDir, reports, meta = {}) {
    const json = { format: 'whatsapp-wal-bericht/1', erstellt: new Date().toISOString(), ...meta, datenbanken: reports };
    fs.writeFileSync(path.join(outputDir, 'wal-bericht.json'), JSON.stringify(json, (k, v) => (v instanceof Set ? [...v] : v), 2));
    const html = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WAL-Bericht</title><style>${CSS}</style></head><body>
<div class="top"><h1>Write-Ahead-Log: was stand drin?</h1>
<div class="sub">Erstellt ${esc(new Date().toLocaleString('de-DE'))} &middot; <a href="index.html">Übersicht</a> &middot; <a href="dokumentation.html">Technische Doku</a> &middot; Maschinenlesbar: <a href="wal-bericht.json">wal-bericht.json</a></div></div>
<div class="wrap">
<h2>Vorgehen</h2><div class="box">
<p>SQLite schreibt Änderungen zuerst in das Write-Ahead-Log (<code>-wal</code>) und überträgt sie erst später in die Hauptdatei. Der aktuelle Stand einer laufenden App ergibt sich daher nur aus <b>Hauptdatei + Log</b>.</p>
<ol>
<li>Hauptdatei, <code>-wal</code> und <code>-shm</code> wurden per Root in <b>einem</b> tar-Strom gelesen (<code>su -c 'cd … &amp;&amp; tar -cf - …'</code>), damit sie denselben Zeitpunkt zeigen. Am Handy wurde nichts verändert.</li>
<li>Diese Dateien liegen <b>unverändert</b> in <code>rohdaten/</code>; ihre SHA-256-Werte stehen unten und im Manifest.</li>
<li><b>Stand A</b> = Hauptdatei allein. <b>Stand B</b> = Kopie, in die das Log eingearbeitet wurde (<code>PRAGMA wal_checkpoint(TRUNCATE)</code>, danach <code>PRAGMA quick_check</code> = ok). Der Chat-Export beruht auf Stand B.</li>
<li>Das Log wurde nach SQLite-Spezifikation zerlegt (Kopf, Salt, Prüfsummenkette je Frame) und jede Seite per <code>dbstat</code> ihrer Tabelle zugeordnet.</li>
<li>Für alle Tabellen mit festgeschriebenen Seiten im Log wurden Stand A und B zeilenweise verglichen (rowid und vollständiger Zeileninhalt, <code>EXCEPT</code>).</li>
</ol>
<p class="muted">Nachprüfen: <code>rohdaten/</code> in einen leeren Ordner kopieren, mit <code>sqlite3</code> öffnen - einmal nur die Hauptdatei (Stand A), einmal zusammen mit der <code>-wal</code> (Stand B) - und die Tabellen vergleichen. Die <code>-shm</code> ist nur zur Dokumentation beigelegt; beim Nachprüfen weglassen.</p>
</div>
${reports.map(reportSectionHtml).join('\n')}
</div></body></html>`;
    fs.writeFileSync(path.join(outputDir, 'wal-bericht.html'), html);
}

module.exports = { parseWal, walChecksum, analyzeLive, walMessageIds, walSummary, writeWalReport };
