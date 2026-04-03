#!/bin/bash
# KinVeda Quick Setup Script
# Run once on first deployment: bash setup.sh

set -e

echo ""
echo "🌿  KinVeda Quick Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi
NODE_VER=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌  Node.js v18+ required. Current: $(node -v)"
  exit 1
fi
echo "✓  Node.js $(node -v)"

# 2. Install dependencies
echo ""
echo "📦  Installing dependencies..."
npm install --silent
echo "    ✓ Dependencies installed"

# 3. Create .env if it doesn't exist
if [ ! -f .env ]; then
  echo ""
  echo "🔐  Generating .env with secure random keys..."
  cp .env.example .env

  # Generate secure random keys
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  ENC_IV=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")

  # Inject into .env (cross-platform sed)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/REPLACE_WITH_64_BYTE_HEX_SECRET/$JWT_SECRET/" .env
    sed -i '' "s/REPLACE_WITH_32_BYTE_HEX_KEY/$ENC_KEY/" .env
    sed -i '' "s/REPLACE_WITH_16_BYTE_HEX_IV/$ENC_IV/" .env
  else
    sed -i "s/REPLACE_WITH_64_BYTE_HEX_SECRET/$JWT_SECRET/" .env
    sed -i "s/REPLACE_WITH_32_BYTE_HEX_KEY/$ENC_KEY/" .env
    sed -i "s/REPLACE_WITH_16_BYTE_HEX_IV/$ENC_IV/" .env
  fi

  echo "    ✓ .env created with random keys"
  echo ""
  echo "    ⚠️  IMPORTANT: Open .env and set:"
  echo "       • ADMIN_EMAIL    — your admin email address"
  echo "       • ADMIN_PASSWORD — strong admin password"
  echo "       • SMTP_USER      — Gmail address for sending emails"
  echo "       • SMTP_PASS      — Gmail App Password"
  echo "       • ADMIN_EMAIL_IDS — admin notification emails"
  echo "       • ADMIN_ROUTE_PREFIX — change to a unique secret path"
  echo ""
  read -p "    Press ENTER when you've updated .env to continue..."
else
  echo ""
  echo "    ✓ .env already exists"
fi

# 4. Create data directory
mkdir -p data

# 5. Initialize database
echo ""
echo "🗄️  Initializing database..."
npm run init-db

# 6. Done
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━"
echo "✅  Setup complete!"
echo ""
echo "   Start the server:   npm start"
echo "   Start (dev mode):   npm run dev"
echo ""
echo "   Admin URL:          Check ADMIN_ROUTE_PREFIX in .env"
echo "   Frontend:           Open kinveda-landing.html in a browser"
echo ""
echo "   ⚠️  Secure your .env file — never commit it to git."
echo ""
