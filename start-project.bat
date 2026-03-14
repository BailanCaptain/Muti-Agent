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

if not exist ".runtime" mkdir ".runtime"

echo [Multi-Agent] Stopping stale processes...
call "%~dp0stop-project.bat" >nul 2>nul

if exist ".next\dev\lock" (
  del /f /q ".next\dev\lock" >nul 2>nul
)

echo [Multi-Agent] Starting API in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath 'npm.cmd' -WorkingDirectory '%CD%' -WindowStyle Hidden -ArgumentList 'run','dev:api' -PassThru; Set-Content -Path '%CD%\.runtime\api.pid' -Value $p.Id"
call :wait_http "http://localhost:8787/health" 20

echo [Multi-Agent] Starting Web in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Start-Process -FilePath 'npm.cmd' -WorkingDirectory '%CD%' -WindowStyle Hidden -ArgumentList 'run','dev:web' -PassThru; Set-Content -Path '%CD%\.runtime\web.pid' -Value $p.Id"
call :wait_http "http://localhost:3000" 25

echo.
echo [Multi-Agent] Background start finished.
echo API: http://localhost:8787
echo WEB: http://localhost:3000
echo.
exit /b 0

:wait_http
set "TARGET_URL=%~1"
set "MAX_RETRY=%~2"
set /a COUNT=0

:wait_loop
set /a COUNT+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing '%TARGET_URL%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 exit /b 0
if %COUNT% geq %MAX_RETRY% exit /b 0
timeout /t 1 /nobreak >nul
goto wait_loop
