const fs = require('fs');
const { spawnSync } = require('child_process');

const DECRYPT_MODULE = 'wa_crypt_tools.wadecrypt';

// Probe denselben Einstiegspunkt und Interpreter, die später verwendet werden.
function detectDecryptPython(run = spawnSync) {
    const diagnostics = [];
    for (const python of ['python', 'py', 'python3']) {
        const result = run(python, ['-m', DECRYPT_MODULE, '--help'], { encoding: 'utf8' });
        if (!result.error && result.status === 0) return { python };
        diagnostics.push(`${python}: ${result.error ? result.error.message : (result.stderr || result.stdout || 'nicht verfügbar').trim()}`);
    }
    return { python: null, diagnostics: diagnostics.join('\n') };
}

function requireDecryptPython() {
    const result = detectDecryptPython();
    if (!result.python) throw new Error(
        'Das Python-Entschlüsselungsprogramm ist nicht startbereit.\n'
        + 'Python installieren und für den verwendeten Interpreter ausführen:\n'
        + '  python -m pip install --upgrade wa-crypt-tools\n'
        + 'Prüfen mit: python -m wa_crypt_tools.wadecrypt --help\n'
        + result.diagnostics);
    return result.python;
}

// key: 64 Hex-Zeichen (E2E-Schlüssel vom Bildschirm) ODER Pfad zu einer echten
// WhatsApp-Schlüsseldatei (files/key bzw. files/encrypted_backup.key per Root).
// crypt14 geht NUR mit der Datei: die letzten 32 Byte als Hex werden von
// wa-crypt-tools als crypt15-Wurzelschlüssel behandelt und passen nicht.
function decryptDatabase(localEnc, key, outDb, python = requireDecryptPython()) {
    const isHex = /^[0-9a-f]{64}$/i.test(key);
    if (!isHex && !(key && fs.existsSync(key))) {
        throw new Error('Ungültiger Schlüssel: 64 Hex-Zeichen oder Schlüsseldatei benötigt.');
    }
    if (fs.existsSync(outDb)) throw new Error('Entschlüsselungsziel existiert bereits: ' + outDb);
    // Eine Textdatei mit Hex-Zeichen ist KEINE wa-crypt-tools-Schlüsseldatei.
    // Der dokumentierte Hex-Parameter benötigt keine temporäre Schlüsseldatei.
    const result = spawnSync(python, ['-m', DECRYPT_MODULE, key, localEnc, outDb], { encoding: 'utf8' });
    const diagnostic = [result.stdout, result.stderr].filter(Boolean).join('\n')
        .replace(/\u001b\[[0-9;]*m/g, '').replace(/[0-9a-f]{64}/gi, '[Schlüssel ausgeblendet]');
    try {
        if (result.error) throw new Error('Python konnte nicht gestartet werden: ' + result.error.code);
        // Ältere Versionen protokollieren manche Fehler trotz Exit-Code 0.
        if (result.status !== 0 || /\[(?:E|C)\]/.test(diagnostic)) {
            throw new Error('Das Entschlüsselungsprogramm meldet einen Fehler.');
        }
        if (!fs.existsSync(outDb)) throw new Error('Keine entschlüsselte Datenbank erzeugt.');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(outDb, { readOnly: true });
        try {
            const checks = db.prepare('PRAGMA quick_check').all();
            if (checks.length !== 1 || checks[0].quick_check !== 'ok') {
                throw new Error('Die entschlüsselte SQLite-Datenbank ist beschädigt.');
            }
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get()) {
                throw new Error('Die entschlüsselte Datenbank enthält keine Tabellen.');
            }
        } finally { db.close(); }
    } catch (error) {
        fs.rmSync(outDb, { force: true });
        throw new Error('Entschlüsselung fehlgeschlagen: ' + error.message
            + '\nMögliche Ursachen: Werkzeugfehler, beschädigtes Backup oder unpassender Schlüssel.\n'
            + diagnostic.trim().split('\n').slice(-12).join('\n'));
    }
    return outDb;
}

module.exports = { detectDecryptPython, requireDecryptPython, decryptDatabase };
