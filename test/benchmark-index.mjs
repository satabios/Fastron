// Run: node test/benchmark-index.mjs (warm metadata indexing; excludes file/network latency).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { indexSource } from '../source/model-index.mjs';
import { writeRepeatedModel } from './repeated-fixtures.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-index-bench-'));
try {
    for (const format of ['onnx', 'gguf']) {
        const { file } = writeRepeatedModel(folder, format, 16384, 4);
        const bytes = fs.readFileSync(file);
        let reads = 0;
        const source = { length: bytes.length, readSync(offset, target) {
            reads++;
            target.set(bytes.subarray(offset, offset + target.length));
        } };
        const kind = format === 'onnx' ? 1 : 2;
        const times = [];
        let result = null;
        for (let i = 0; i < 15; i++) {
            reads = 0;
            const start = performance.now();
            // eslint-disable-next-line no-await-in-loop
            result = await indexSource(source, kind);
            if (i >= 5) {
                times.push(performance.now() - start);
            }
        }
        assert.ok(result.metadata.byteLength > 0);
        assert.ok(kind !== 1 || result.ranges.length === 16384);
        times.sort((a, b) => a - b);
        const metadataHash = createHash('sha256').update(new Uint8Array(result.metadata)).update(JSON.stringify(result.ranges)).digest('hex');
        process.stdout.write(`${JSON.stringify({ format, nodes: 32768, medianMs: (times[4] + times[5]) / 2,
            reads, metadataBytes: result.metadata.byteLength, metadataHash })}\n`);
    }
} finally {
    fs.rmSync(folder, { recursive: true, force: true });
}
