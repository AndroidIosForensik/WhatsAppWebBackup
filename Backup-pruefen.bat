@echo off
setlocal
chcp 65001 >nul
title WhatsApp-Backup pruefen

rem In den Ordner dieses Skripts wechseln (egal von wo gestartet)
cd /d "%~dp0"

call "%~dp0Node-finden.bat"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Integritaetspruefung der WhatsApp-Backups
echo   Tipp: Einen Backup-Ordner auf diese Datei ziehen prueft
echo   genau diesen Ordner. Ohne Angabe: das neueste Backup.
echo ============================================================
echo.

rem Per Drag-and-drop uebergebenen Ordner (Argument 1) weiterreichen
if "%~1"=="" (
    "%NODE_EXE%" backup.js --pruefen
) else (
    "%NODE_EXE%" backup.js --pruefen "%~1"
)

echo.
pause
