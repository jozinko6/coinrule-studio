@echo off
chcp 65001 >nul
setlocal EnableExtensions
title CoinRule Studio

rem ---------------------------------------------------------------------------
rem  CoinRule Studio - one-click launcher (Windows)
rem
rem  Starts the local backend (API + UI on 127.0.0.1) and opens the browser
rem  only after /api/health answers. The backend lives in this window, so
rem  Ctrl+C or closing the window shuts it down cleanly.
rem
rem  Optional:  SPUSTIT.bat 8888     use a different port (default 8787)
rem  For tests: set COINRULE_NO_BROWSER=1 to skip opening the browser.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8787"
set "BADPORT="
for /f "delims=0123456789" %%A in ("%PORT%") do set "BADPORT=1"
if defined BADPORT (
  echo Neplatny port "%PORT%", pouzivam predvoleny 8787.
  set "PORT=8787"
)

echo.
echo   CoinRule Studio - lokalny backend
echo   Adresa:    http://127.0.0.1:%PORT%
echo   Mod:       PAPER (live je vypnuty)
echo   Ukoncenie: zavri toto okno alebo stlac Ctrl+C
echo.

if "%COINRULE_NO_BROWSER%"=="1" goto :serve
start "" /b node "%~dp0tools\open-when-ready.mjs" --port %PORT%

:serve
node "%~dp0server\app.mjs" --port %PORT%
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" (
  echo Backend sa zastavil s chybou %CODE%.
  echo Pravdepodobne je port %PORT% obsadeny inou aplikaciou,
  echo alebo databaza v priecinku data\ je poskodena.
  echo Skus iny port, napriklad:   SPUSTIT.bat 8888
) else (
  echo Backend bol ukonceny.
)
echo.
pause
exit /b %CODE%

:no_node
echo.
echo   Node.js sa nenasiel.
echo   CoinRule Studio potrebuje Node.js 18 alebo novsi.
echo   Stiahni ho z:   https://nodejs.org/
echo.
pause
exit /b 1