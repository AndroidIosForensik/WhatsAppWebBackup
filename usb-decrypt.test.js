const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { detectDecryptPython, decryptDatabase } = require('./usb-decrypt');

test('findet einen Interpreter mit funktionierendem Entschlüsselungsmodul', () => {
    const tried = [];
    const result = detectDecryptPython((python, args) => {
        tried.push(python);
        assert.deepEqual(args, ['-m', 'wa_crypt_tools.wadecrypt', '--help']);
        return { status: python === 'py' ? 0 : 1, stderr: 'Modul fehlt' };
    });
    assert.equal(result.python, 'py');
    assert.deepEqual(tried, ['python', 'py']);
});

test('USB und Prüfung können ohne Web-Pakete geladen werden', () => {
    const script = `
        const Module = require('module');
        const original = Module._load;
        Module._load = function(name, ...args) {
            if (['whatsapp-web.js', 'qrcode-terminal'].includes(name)) throw Error('Web-Paket geladen');
            return original.call(this, name, ...args);
        };
        require('./usb-backup');
        require('./menu');
    `;
    const result = spawnSync(process.execPath, ['-e', script], { cwd: __dirname, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});

test('Windows-Starter findet portable Laufzeit ohne Node im PATH', { skip: process.platform !== 'win32' }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa portable test '));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const runtime = path.join(dir, 'runtime');
    fs.mkdirSync(runtime);
    const portable = path.join(runtime, 'node.exe');
    fs.copyFileSync(process.execPath, portable);
    fs.copyFileSync(path.join(__dirname, 'Node-finden.bat'), path.join(dir, 'Node-finden.bat'));
    fs.writeFileSync(path.join(dir, 'probe.bat'), [
        '@echo off', 'call "%~dp0Node-finden.bat"', 'if errorlevel 1 exit /b 1',
        '"%NODE_EXE%" -p "process.execPath"', ''
    ].join('\r\n'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = path.join(process.env.SystemRoot, 'System32');
    const result = spawnSync(process.env.ComSpec, ['/d', '/c', 'probe.bat'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout.trim().toLowerCase(), portable.toLowerCase());
});

test('crypt15: echter Rundlauf, falscher Schlüssel und beschädigte Datei', (t) => {
    const { python } = detectDecryptPython();
    if (!python) { t.skip('Python mit wa-crypt-tools erforderlich'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-decrypt-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const plain = path.join(dir, 'source.db');
    const encrypted = path.join(dir, 'source.crypt15');
    const output = path.join(dir, 'decoded.db');
    const key = '11'.repeat(32); // Ausschließlich synthetische Testdaten.
    const db = new DatabaseSync(plain);
    db.exec("CREATE TABLE message (text_data TEXT); INSERT INTO message VALUES ('Testnachricht');");
    db.close();
    const encryption = spawnSync(python, ['-m', 'wa_crypt_tools.waencrypt', key, plain, encrypted], { encoding: 'utf8' });
    assert.equal(encryption.status, 0, encryption.stderr);
    assert.equal(decryptDatabase(encrypted, key, output, python), output);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(plain));
    assert.throws(() => decryptDatabase(encrypted, key, output, python), /existiert bereits/);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(plain));
    const wrong = path.join(dir, 'wrong.db');
    assert.throws(() => decryptDatabase(encrypted, '22'.repeat(32), wrong, python), /Entschlüsselung fehlgeschlagen/);
    assert.equal(fs.existsSync(wrong), false);
    const damaged = path.join(dir, 'damaged.crypt15');
    const data = fs.readFileSync(encrypted);
    data[data.length - 25] ^= 0xff;
    fs.writeFileSync(damaged, data);
    assert.throws(() => decryptDatabase(damaged, key, wrong, python), /Entschlüsselung fehlgeschlagen/);
    assert.equal(fs.existsSync(wrong), false);
});
