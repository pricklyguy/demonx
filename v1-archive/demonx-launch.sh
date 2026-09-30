#!/bin/bash
# DemonX Launcher — starts server if not running, then opens Chrome
# Place this in ~/Downloads/demonx-server/

PORT=8080
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if already running via PM2
if command -v pm2 &> /dev/null; then
  STATUS=$(pm2 list 2>/dev/null | grep demonx | grep -c online)
  if [ "$STATUS" -gt 0 ]; then
    echo "DemonX already running via PM2"
  else
    echo "Starting DemonX via PM2..."
    pm2 start "$SERVER_DIR/server.js" --name demonx --cwd "$SERVER_DIR"
    sleep 2
  fi
else
  # No PM2 — start raw node in background if not already running
  if ! pgrep -f "node server.js" > /dev/null; then
    echo "Starting DemonX server..."
    cd "$SERVER_DIR"
    nohup node server.js > "$SERVER_DIR/demonx.log" 2>&1 &
    sleep 2
  else
    echo "DemonX server already running"
  fi
fi

# Open Chrome to the control page
google-chrome --new-window "http://localhost:${PORT}" \
  --app="http://localhost:${PORT}" \
  --start-maximized 2>/dev/null &
