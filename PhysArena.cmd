@echo off
setlocal
cd /d "%~dp0"

rem PhysArena launcher: build, serve, and open the browser.
rem Double-click this file. Close the window to stop the server.

where node >nul 2>&1
if errorlevel 1 (
  echo [PhysArena] Node.js not found in PATH. Install Node 22+ and retry.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [PhysArena] Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 goto :fail
)

echo [PhysArena] Building...
call npm run build
if errorlevel 1 goto :fail

echo [PhysArena] Starting server and opening browser...
echo [PhysArena] Close this window to stop the server.
rem --strictPort: fail loudly if 4173 is taken, instead of silently moving.
rem --host 127.0.0.1: pin to IPv4. Left to itself vite may bind only [::1],
rem which breaks on machines where the browser resolves localhost to 127.0.0.1.
call npm run preview -- --open --strictPort --host 127.0.0.1
goto :eof

:fail
echo.
echo [PhysArena] Launch failed. See the error above.
pause
