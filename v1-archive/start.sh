#!/bin/bash
echo "╔══════════════════════════════════════╗"
echo "║       DemonX CNC Server Setup        ║"
echo "╚══════════════════════════════════════╝"

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Install from https://nodejs.org"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install || { echo "ERROR: npm install failed"; exit 1; }
fi

echo ""
echo "Starting DemonX server..."
echo "Press Ctrl+C to stop."
echo ""
node server.js
