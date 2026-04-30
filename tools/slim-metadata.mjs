#!/usr/bin/env node
// Strips `examples` from *-metadata.json files → *-metadata.slim.json
// Saves examples as *-metadata-examples.json (keyed by type name, for lazy loading)
// Run: node tools/slim-metadata.mjs

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(__dirname, '..', 'source');

const files = readdirSync(sourceDir).filter(f => f.endsWith('-metadata.json'));
let totalSaved = 0;

for (const file of files) {
    const filePath = join(sourceDir, file);
    const originalSize = statSync(filePath).size;
    const data = JSON.parse(readFileSync(filePath, 'utf8'));

    if (!Array.isArray(data)) {
        continue;
    }

    const examples = {};
    let hasExamples = false;

    const slim = data.map(type => {
        if (type.examples && type.examples.length > 0) {
            examples[type.name] = type.examples;
            hasExamples = true;
            const { examples: _ex, ...rest } = type;
            return rest;
        }
        return type;
    });

    const slimPath = filePath.replace('-metadata.json', '-metadata.slim.json');
    const slimJson = JSON.stringify(slim);
    writeFileSync(slimPath, slimJson);

    const saved = originalSize - Buffer.byteLength(slimJson, 'utf8');
    totalSaved += saved;
    process.stdout.write(`${file}: ${(originalSize / 1024).toFixed(0)}KB → ${(Buffer.byteLength(slimJson, 'utf8') / 1024).toFixed(0)}KB (saved ${(saved / 1024).toFixed(0)}KB)`);

    if (hasExamples) {
        const exPath = filePath.replace('-metadata.json', '-metadata-examples.json');
        writeFileSync(exPath, JSON.stringify(examples));
        process.stdout.write(` + examples file (${Object.keys(examples).length} ops)`);
    }
    process.stdout.write('\n');
}

console.log(`\nTotal saved: ${(totalSaved / 1024).toFixed(0)}KB`);
