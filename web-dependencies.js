const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureWebDependencies() {
    try {
        require.resolve('whatsapp-web.js');
        require.resolve('qrcode-terminal');
        return true;
    } catch { /* Erst beim Web-Backup installieren. */ }
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) {
        console.error('Für WhatsApp Web fehlen Pakete. Bitte das vollständige Node.js-ZIP\n'
            + 'nach runtime entpacken (inklusive npm), oder im Projekt npm install ausführen.');
        return false;
    }
    console.log('Installiere Pakete für WhatsApp Web (Internet beim ersten Start erforderlich) ...');
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
    const oldPath = pathKey ? env[pathKey] : '';
    if (pathKey) delete env[pathKey];
    env.PATH = path.dirname(process.execPath) + path.delimiter + oldPath;
    const result = spawnSync(process.execPath, [npmCli, 'install'], {
        cwd: __dirname, stdio: 'inherit', env
    });
    if (result.error || result.status !== 0) {
        console.error('Paketinstallation fehlgeschlagen. Bitte die Meldung oben prüfen.');
        return false;
    }
    return true;
}

module.exports = { ensureWebDependencies };
