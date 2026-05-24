#!/bin/bash
# DemonX Autostart Setup for Linux Mint
# - Installs PM2, registers demonx-server as a system service
# - Removes axiocnc autostart if present
# - Opens Chrome to the control page on desktop login
# Run once as your normal user (not root)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=${PORT:-8080}

echo "╔══════════════════════════════════════════════════╗"
echo "║        DemonX Autostart Setup                    ║"
echo "╚══════════════════════════════════════════════════╝"

# ── 1. Install PM2 globally ──────────────────────────────────────────────────
if ! command -v pm2 &> /dev/null; then
  echo "[1/5] Installing PM2..."
  npm install -g pm2
else
  echo "[1/5] PM2 already installed: $(pm2 --version)"
fi

# ── 2. Remove axiocnc from PM2 if running ───────────────────────────────────
echo "[2/5] Removing axiocnc from PM2 if present..."
pm2 delete axiocnc 2>/dev/null && echo "      axiocnc removed" || echo "      axiocnc not found (ok)"

# ── 3. Register DemonX with PM2 ─────────────────────────────────────────────
echo "[3/5] Starting DemonX server in PM2..."
pm2 delete demonx 2>/dev/null || true
pm2 start "$SCRIPT_DIR/server.js" \
  --name demonx \
  --cwd "$SCRIPT_DIR" \
  --log "$SCRIPT_DIR/demonx.log" \
  --time \
  --restart-delay 2000
pm2 save

# ── 4. Enable PM2 to start on boot ──────────────────────────────────────────
echo "[4/5] Enabling PM2 on system boot..."
# pm2 startup prints a command you must run as root — we capture and run it
STARTUP_CMD=$(pm2 startup systemd -u "$USER" --hp "$HOME" | grep "sudo env PATH" | head -1)
if [ -n "$STARTUP_CMD" ]; then
  echo "      Running: $STARTUP_CMD"
  eval "$STARTUP_CMD"
else
  echo "      PM2 startup already configured or needs manual run."
  echo "      Run:  pm2 startup   then follow the printed instruction."
fi

# ── 5. Open Chrome on desktop login ─────────────────────────────────────────
echo "[5/5] Adding Chrome autostart for control page..."
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"

cat > "$AUTOSTART_DIR/demonx-browser.desktop" << EOF
[Desktop Entry]
Type=Application
Name=DemonX Control Page
Comment=Open DemonX CNC controller in Chrome on login
Exec=bash -c 'sleep 4 && google-chrome --new-window http://localhost:${PORT} --app=http://localhost:${PORT} --start-maximized'
X-GNOME-Autostart-enabled=true
EOF

# Remove axiocnc browser autostart if it exists
if [ -f "$AUTOSTART_DIR/axiocnc-browser.desktop" ]; then
  rm "$AUTOSTART_DIR/axiocnc-browser.desktop"
  echo "      Removed axiocnc browser autostart"
fi
# Also check for generic axiocnc autostart names
for f in "$AUTOSTART_DIR"/*axiocnc* "$AUTOSTART_DIR"/*axio*; do
  [ -f "$f" ] && rm "$f" && echo "      Removed: $f"
done

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Setup complete!                                 ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  DemonX server:  pm2 status                      ║"
echo "║  View logs:      pm2 logs demonx                 ║"
echo "║  Stop:           pm2 stop demonx                 ║"
echo "║  Restart:        pm2 restart demonx              ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║  Chrome will open http://localhost:${PORT}           ║"
echo "║  automatically on next desktop login.            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Reboot or log out/in to test autostart."
