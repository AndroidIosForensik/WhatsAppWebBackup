@echo off
setlocal
chcp 65001 >nul
title WhatsApp-Backup

cd /d "%~dp0"

call "%~dp0Node-finden.bat"
if errorlevel 1 (
    pause
    exit /b 1
)

"%NODE_EXE%" menu.js

echo.
pause
