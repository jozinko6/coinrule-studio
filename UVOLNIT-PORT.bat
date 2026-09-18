@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Uvolnenie portu

rem ---------------------------------------------------------------------------
rem  UVOLNIT-PORT.bat - uvolni lokalny TCP port (predvolene 8787)
rem
rem  Pouzitie:
rem    UVOLNIT-PORT.bat            uvolni port 8787
rem    UVOLNIT-PORT.bat 8888       uvolni iny port
rem
rem  Vypise, ktory proces port drzal, zastavi ho a overi, ze je port volny.
rem  Pre testy: COINRULE_NO_PAUSE=1 preskoci cakanie na stlacenie klavesy.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8787"
set "BADPORT="
for /f "delims=0123456789" %%A in ("%PORT%") do set "BADPORT=1"
if defined BADPORT (
  echo Neplatny port "%PORT%", pouzivam predvoleny 8787.
  set "PORT=8787"
)

echo.
echo   Uvolnujem port %PORT% ...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$port=%PORT%; $conns=@(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Where-Object {$_.State -eq 'Listen'}); if($conns.Count -eq 0){Write-Host ('  Port ' + $port + ' je uz VOLNY.'); exit 0}; $pids=@($conns | Select-Object -ExpandProperty OwningProcess -Unique); foreach($procId in $pids){$p=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $procId) -ErrorAction SilentlyContinue; $label=if($p){$p.Name}else{'neznama'}; Write-Host ('  Zastavujem PID ' + $procId + ' (' + $label + ')'); if($p){Write-Host ('    ' + $p.CommandLine)}; try{Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Host '    zastavene'}catch{Write-Host ('    nepodarilo sa: ' + $_.Exception.Message)}}; Start-Sleep -Milliseconds 500; $left=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); if($left.Count -eq 0){Write-Host ('  Port ' + $port + ' je VOLNY a pripraveny.'); exit 0}else{Write-Host ('  Port ' + $port + ' je stale obsadeny - skus spustit ako administrator.'); exit 1}"

set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (
  echo   Port sa nepodarilo uvolnit ^(kod %CODE%^).
  echo   Ak ho drzi sluzba Windows, spusti tento subor ako administrator.
) else (
  echo   Hotovo. Mozes spustit:  SPUSTIT.bat
)
echo.

if "%COINRULE_NO_PAUSE%"=="1" exit /b %CODE%
pause
exit /b %CODE%