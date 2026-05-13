#!/usr/bin/env node
/**
 * sync-assets.js
 * Copies shared model/format files from ../source/ into webview/netron/.
 * Run via: npm run sync (automatically called before compile/build).
 *
 * Copies: *.js, *.json  (NOT *.html, *.py, *.css — those are app/extension-specific)
 * Output: vscode-extension/webview/netron/
 */

const fs = require('fs');
const path = require('path');

const sourceDir = path.resolve(__dirname, '../../source');
const destDir = path.resolve(__dirname, '../webview/netron');
const COPY_EXTS = new Set(['.js', '.json']);
const SKIP_FILES = new Set(['package.json']);  // root package.json, not a netron asset

if (!fs.existsSync(sourceDir)) {
    console.error(`sync-assets: source dir not found: ${sourceDir}`);
    process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });

const files = fs.readdirSync(sourceDir);
let copied = 0;
let skipped = 0;

for (const file of files) {
    const ext = path.extname(file);
    if (!COPY_EXTS.has(ext) || SKIP_FILES.has(file)) {
        skipped++;
        continue;
    }
    const src = path.join(sourceDir, file);
    const dst = path.join(destDir, file);
    if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dst);
        copied++;
    }
}

console.log(`sync-assets: copied ${copied} files from source/ → webview/netron/ (skipped ${skipped})`);
