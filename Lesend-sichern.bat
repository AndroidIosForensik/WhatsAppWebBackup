@echo off
setlocal
chcp 65001 >nul
title Lesende Zustandssicherung (WhatsApp)

cd /d "%~dp0"

call "%~dp0Node-finden.bat"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Lesende Zustandssicherung (rein lesend, veraendert nichts)
echo.
echo   Zieht den WhatsApp-Ordner vom Handy und schreibt Protokoll
echo   + SHA-256-Pruefsummen. KEIN Entschluesseln, KEIN Schluessel
echo   noetig. Fuer "Zustand bewahren, bevor man etwas aendert".
echo.
echo   Voraussetzung: Handy per USB, entsperrt, USB-Debugging an,
echo   adb im PATH.  Fuer den ganzen Speicher:  --all-sdcard
echo ============================================================
echo.

"%NODE_EXE%" usb-backup.js --preserve %*

echo.
pause
