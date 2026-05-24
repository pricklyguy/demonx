@echo off
echo ╔══════════════════════════════════════╗
echo ║       DemonX CNC Server Setup        ║
echo ╚══════════════════════════════════════╝

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo ERROR: npm install failed
        pause
        exit /b 1
    )
)

echo.
echo Starting DemonX server...
echo Press Ctrl+C to stop.
echo.
node server.js
pause
