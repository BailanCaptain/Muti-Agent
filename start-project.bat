@echo off
setlocal

cd /d "%~dp0"

if not exist "package.json" (
  echo [Multi-Agent] Invalid working directory.
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [Multi-Agent] npm.cmd not found. Please install Node.js first.
  exit /b 1
)

where curl.exe >nul 2>nul
if errorlevel 1 (
  echo [Multi-Agent] curl.exe not found ^(requires Windows 10 build 17063 or later^).
  exit /b 1
)

if not exist ".runtime" mkdir ".runtime"

echo [Multi-Agent] Stopping stale processes...
call "%~dp0stop-project.bat" >nul 2>nul

if exist ".next\dev\lock" (
  del /f /q ".next\dev\lock" >nul 2>nul
)

echo [Multi-Agent] Starting API in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath 'npm.cmd' -WorkingDirectory '%CD%' -WindowStyle Hidden -ArgumentList 'run','dev:api' -PassThru; Set-Content -Path '%CD%\.runtime\api.pid' -Value $p.Id"
call :wait_for "http://localhost:8787/health" 60
echo.

echo [Multi-Agent] Starting Web in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath 'npm.cmd' -WorkingDirectory '%CD%' -WindowStyle Hidden -ArgumentList 'run','dev:web' -PassThru; Set-Content -Path '%CD%\.runtime\web.pid' -Value $p.Id"
call :wait_for "http://localhost:3000" 60
echo.

echo.
echo [Multi-Agent] Ready.
echo   API: http://localhost:8787
echo   WEB: http://localhost:3000
echo.
exit /b 0

:: -----------------------------------------------------------------------
:: :wait_for <url> <max_seconds>
:: Uses curl.exe (built into Windows 10+) for a hard-capped 2s timeout per
:: attempt. Prints a dot per second so the console never looks frozen.
:: -----------------------------------------------------------------------
:wait_for
set "WF_URL=%~1"
set /a WF_MAX=%~2
set /a WF_COUNT=0

:_wf_loop
curl.exe -s -o nul --max-time 2 --connect-timeout 2 "%WF_URL%" >nul 2>nul
if not errorlevel 1 exit /b 0

set /a WF_COUNT+=1
if %WF_COUNT% geq %WF_MAX% (
  echo  [timeout after %WF_MAX%s, continuing anyway]
  exit /b 0
)
<nul set /p ".=."
timeout /t 1 /nobreak >nul
goto _wf_loop
