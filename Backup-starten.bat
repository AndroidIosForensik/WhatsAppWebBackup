@echo off
setlocal
chcp 65001 >nul
title WhatsApp-Backup

rem In den Ordner dieses Skripts wechseln (egal von wo gestartet)
cd /d "%~dp0"

call "%~dp0Node-finden.bat"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   WhatsApp-Backup wird gestartet
echo   Gleich einen QR-Code im Browser-Fenster scannen:
echo   WhatsApp am Handy - Verknuepfte Geraete - Geraet hinzufuegen
echo ============================================================
echo.

rem Backup starten; alle uebergebenen Argumente (z.B. --wait 120) weiterreichen
"%NODE_EXE%" backup.js %*

echo.
echo ============================================================
echo   Fertig. Das Backup liegt im Ordner "backup".
echo.
echo   WICHTIG: Verknuepftes Geraet wieder trennen!
echo   Handy: WhatsApp - Einstellungen - Verknuepfte Geraete
echo   - diesen Eintrag antippen - Abmelden
echo ============================================================
echo.
pause
