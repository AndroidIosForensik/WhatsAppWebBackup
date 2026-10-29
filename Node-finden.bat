@echo off
rem Gemeinsame Suche; Variablen bleiben im setlocal des aufrufenden Starters.
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if defined NODE_EXE goto check
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if defined NODE_EXE goto check
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if defined NODE_EXE goto check
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto check
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto check
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if defined NODE_EXE goto check
echo Node.js fehlt. Eine Installation ist nicht erforderlich:
echo Node.js 24 LTS als Windows-ZIP von https://nodejs.org/en/download laden.
echo ZIP-Inhalt nach "%~dp0runtime" entpacken, sodass runtime\node.exe existiert.
exit /b 1

:check
"%NODE_EXE%" -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
    echo Diese Node.js-Version unterstuetzt SQLite nicht. Bitte Node.js 24 LTS verwenden.
    exit /b 1
)
for %%N in ("%NODE_EXE%") do set "PATH=%%~dpN;%PATH%"
exit /b 0
