#!/bin/bash
set -e

echo ""
echo "  =============================================="
echo "   KinVeda - Starting Local Development Server"
echo "  =============================================="
echo ""

cd "$(dirname "$0")/kinveda-backend"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
  echo ""
fi

# Initialise database if needed
if [ ! -f "data/kinveda.db" ]; then
  echo "  Initialising database..."
  npm run init-db
  echo ""
fi

echo "  Starting server on http://localhost:3001"
echo "  Press Ctrl+C to stop."
echo ""
npm start
