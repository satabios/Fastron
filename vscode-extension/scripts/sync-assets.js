#!/usr/bin/env node
/**
 * sync-assets.js
 * Copies shared model/format files from ../source/ into webview/netron/.
 * Run via: npm run sync (automatically called before compile/build).
 *
 * Copies shared scripts, metadata and graph styles; HTML stays extension-specific.
 * Output: vscode-extension/webview/netron/
 */

const fs = require('fs');
const path = require('path');

const sourceDir = path.resolve(__dirname, '../../source');
const destDir = path.resolve(__dirname, '../webview/netron');
const COPY_EXTS = new Set(['.js', '.mjs', '.wasm', '.json', '.css']);
const SKIP_FILES = new Set(['package.json']);  // root package.json, not a netron asset

if (!fs.existsSync(sourceDir)) {
    console.error(`sync-assets: source dir not found: ${sourceDir}`);
    process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });

const sync = async () => {
    const { validateMetadataAssets } = await import('../../tools/metadata-assets.mjs');
    const originals = await validateMetadataAssets(sourceDir);
    const files = fs.readdirSync(sourceDir);
    for (const file of fs.readdirSync(destDir)) {
        if (COPY_EXTS.has(path.extname(file)) && !SKIP_FILES.has(file) && !files.includes(file)) {
            fs.rmSync(path.join(destDir, file), { force: true });
        }
    }
    let copied = 0;
    let skipped = 0;
    for (const file of files) {
        const ext = path.extname(file);
        if (!COPY_EXTS.has(ext) || SKIP_FILES.has(file) || originals.has(file)) {
            if (originals.has(file)) {
                fs.rmSync(path.join(destDir, file), { force: true });
            }
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
};
sync().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
