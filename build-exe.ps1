param([string]$OutputDirectory = 'dist')

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$buildDir = Join-Path $projectRoot 'build'
$distDir = if ([IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $projectRoot $OutputDirectory }
New-Item -ItemType Directory -Force -Path $buildDir, $distDir | Out-Null
$nodeExe = Join-Path $projectRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { $nodeExe = (Get-Command node.exe).Source }
$browserExe = & $nodeExe -e "console.log(require('puppeteer').executablePath())"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $browserExe)) { throw 'Puppeteer-Browser fehlt. Zuerst npm install ausführen.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C#-Compiler fehlt.' }

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$payload = Join-Path $buildDir 'payload.zip'
$stream = [IO.File]::Create($payload)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
function Add-PayloadFile([string]$Source, [string]$Target) {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $Source, $Target.Replace('\', '/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
try {
    # Ausschließlich Programmdateien: keine Backups, Sitzungen oder Cache-Dateien.
    $scripts = @('menu.js', 'backup.js', 'usb-backup.js', 'usb-decrypt.js', 'usb-contacts.js', 'usb-wal.js', 'web-dependencies.js', 'web-history.js', 'web-media.js', 'exe-self-test.js', 'DOKUMENTATION.md', 'README.md', 'package.json', 'package-lock.json')
    foreach ($name in $scripts) { Add-PayloadFile (Join-Path $projectRoot $name) $name }
    Add-PayloadFile $nodeExe 'runtime/node.exe'
    Add-PayloadFile (Join-Path $projectRoot 'runtime\LICENSE') 'runtime/LICENSE'
    foreach ($part in @(@{Source=(Join-Path $projectRoot 'node_modules'); Target='node_modules'}, @{Source=(Split-Path $browserExe); Target='browser'})) {
        foreach ($file in [IO.Directory]::EnumerateFiles($part.Source, '*', [IO.SearchOption]::AllDirectories)) {
            $relative = $file.Substring($part.Source.Length + 1)
            Add-PayloadFile $file ($part.Target + '/' + $relative)
        }
    }
} finally { $zip.Dispose(); $stream.Dispose() }
$hash = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$source = [IO.File]::ReadAllText((Join-Path $projectRoot 'windows\Launcher.cs')).Replace('PAYLOAD_BUILD_ID', $hash.Substring(0, 16)).Replace('APP_VERSION', $version)
$generated = Join-Path $buildDir 'Launcher.cs'
[IO.File]::WriteAllText($generated, $source, [Text.UTF8Encoding]::new($false))
$output = Join-Path $distDir 'WhatsApp-Backup.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$payload,payload.zip" "/out:$output" $generated
if ($LASTEXITCODE -ne 0) { throw 'EXE-Kompilierung fehlgeschlagen.' }
$exeHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $distDir 'WhatsApp-Backup.exe.sha256'), "$exeHash  WhatsApp-Backup.exe`n")
Write-Output "Erstellt: $output ($([Math]::Round((Get-Item -LiteralPath $output).Length / 1MB, 1)) MB)"
