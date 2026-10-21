// Index-only comparison. Never scans or copies the full remote model.
import assert from 'node:assert/strict';
import { bufferedSource } from '../source/model-source-reader.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { indexSource } from '../source/model-index.mjs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
    const mode = process.argv[3];
    const filename = process.argv[4];
    const fd = fs.openSync(filename, 'r');
    try {
        const stat = fs.fstatSync(fd, { bigint: true });
        const length = Number(stat.size);
        let reads = 0;
        let bytes = 0;
        let readMs = 0;
        const sizes = {};
        const source = { length, readSync(position, target) {
            const start = performance.now();
            let count = 0;
            while (count < target.length) {
                const got = fs.readSync(fd, target, count, target.length - count, position + count);
                if (!got) {
                    throw new Error('Unexpected EOF.');
                }
                count += got;
            }
            readMs += performance.now() - start;
            reads++;
            bytes += count;
            sizes[target.length] = (sizes[target.length] || 0) + 1;
        } };
        const start = performance.now();
        const result = await indexSource(mode === 'adaptive' ? bufferedSource(source) : source, 1);
        const indexMs = performance.now() - start;
        const after = fs.fstatSync(fd, { bigint: true });
        assert.equal(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`, `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}`);
        process.stdout.write(JSON.stringify({ mode, status: 'ok', indexMs, readMs, reads, bytes, sizes,
            metadataBytes: result.metadata.byteLength, tensorRanges: result.ranges.length,
            metadataHash: createHash('sha256').update(new Uint8Array(result.metadata)).digest('hex'),
            rangesHash: createHash('sha256').update(JSON.stringify(result.ranges)).digest('hex') }));
    } finally {
        fs.closeSync(fd);
    }
} else {
    const filename = process.argv[2];
    const output = path.resolve(process.argv[3] || 'dist/benchmark-onnx/03abf007/orion-policy.json');
    const report = { filename, revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
        scope: 'Exact versus adaptive Rust indexing only; excludes canonicalization, open/stat, parse/render; fresh process each trial, no forced cold cache.',
        started: new Date().toISOString(), trials: [] };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
    save();
    for (let trial = 1; trial <= 3; trial++) {
        for (const mode of trial % 2 ? ['adaptive', 'exact'] : ['exact', 'adaptive']) {
            process.stdout.write(`Trial ${trial} ${mode}\n`);
            const child = spawnSync(process.execPath, [self, '--child', mode, filename], {
                encoding: 'utf8', timeout: 180000, maxBuffer: 1048576
            });
            let entry = null;
            try {
                if (child.error || child.status !== 0) {
                    throw child.error || new Error(child.stderr);
                }
                entry = JSON.parse(child.stdout);
            } catch (error) {
                entry = { mode, status: 'error', error: error.message };
            }
            report.trials.push({ trial, ...entry });
            save();
            process.stdout.write(`${JSON.stringify(entry)}\n`);
        }
    }
    const good = report.trials.filter((entry) => entry.status === 'ok');
    report.hashesMatch = good.length === 6 && new Set(good.map((entry) => `${entry.metadataHash}:${entry.rangesHash}`)).size === 1;
    report.finished = new Date().toISOString();
    save();
    process.exitCode = report.hashesMatch ? 0 : 1;
}