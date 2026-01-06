#!/bin/bash

# VSCode Netron Extension - Build Script
# This script installs dependencies and compiles the extension

set -e  # Exit on error

echo "================================================"
echo "VSCode Netron Extension - Build Script"
echo "================================================"
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed"
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

echo "✓ npm found: $(npm --version)"
echo "✓ node found: $(node --version)"
echo ""

# Check Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 14 ]; then
    echo "⚠️  Warning: Node.js version is too old (v$NODE_VERSION)"
    echo "TypeScript 5.x requires Node.js 14 or higher"
    echo ""
    echo "Options:"
    echo "1. Update Node.js (recommended):"
    echo "   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    echo "   source ~/.bashrc"
    echo "   nvm install --lts"
    echo "   nvm use --lts"
    echo ""
    echo "2. Use older TypeScript:"
    echo "   npm uninstall typescript"
    echo "   npm install --save-dev typescript@4.5.5"
    echo ""
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✓ Dependencies installed"
echo ""

# Compile TypeScript
echo "🔨 Compiling TypeScript..."
npm run compile

if [ $? -ne 0 ]; then
    echo "❌ Failed to compile TypeScript"
    exit 1
fi

echo "✓ TypeScript compiled successfully"
echo ""

# Verify output
if [ -f "out/extension.js" ]; then
    echo "✓ Extension compiled: out/extension.js"
    echo "✓ File size: $(du -h out/extension.js | cut -f1)"
else
    echo "❌ Error: out/extension.js not found"
    exit 1
fi

echo ""
echo "================================================"
echo "✅ Build completed successfully!"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Reload VSCode window (Ctrl+Shift+P → 'Developer: Reload Window')"
echo "2. Open a model file (.onnx, .pb, .h5, etc.)"
echo "3. Right-click → 'Open in Netron'"
echo ""
echo "For development, run: npm run watch"
echo ""
