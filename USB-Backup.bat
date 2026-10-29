@echo off
setlocal
chcp 65001 >nul
title WhatsApp-Backup ueber USB

cd /d "%~dp0"

call "%~dp0Node-finden.bat"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   WhatsApp-Backup ueber USB (offline)
echo.
echo   Voraussetzungen:
echo    - Handy per USB verbunden, entsperrt, USB-Debugging an
echo    - adb (Android Platform-Tools) im PATH
echo    - Python + wa-crypt-tools  (pip install wa-crypt-tools)
echo.
echo   Du brauchst den 64-stelligen E2E-Schluessel aus der App:
echo   WhatsApp - Einstellungen - Chats - Backup -
echo   E2E-verschluesseltes Backup - Schluessel anzeigen
echo ============================================================
echo.

"%NODE_EXE%" usb-backup.js %*

echo.
pause
