@echo off
setlocal

cd /d "%~dp0"

echo [Multi-Agent] Stopping background processes...

call :kill_pid_file ".runtime\api.pid"
call :kill_pid_file ".runtime\web.pid"

call :kill_port 3000
call :kill_port 3001
call :kill_port 8787

if exist ".next\dev\lock" (
  del /f /q ".next\dev\lock" >nul 2>nul
)

echo [Multi-Agent] Cleanup finished.
exit /b 0

:kill_pid_file
if exist %1 (
  set /p TARGET_PID=<%1
  if not "%TARGET_PID%"=="" (
    taskkill /PID %TARGET_PID% /T /F >nul 2>nul
  )
  del /f /q %1 >nul 2>nul
)
exit /b 0

:kill_port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%1 .*LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>nul
)
exit /b 0
