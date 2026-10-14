// Run: node test/benchmark-loading.mjs [model path] [--latency=10] [--size=256]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatKind, indexSource } from '../source/model-index.mjs';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const option = (name, fallback) => Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const latency = option('latency', 0);
const size = option('size', 256);
if (!Number.isFinite(latency) || latency < 0 || !Number.isSafeInteger(size) || size < 1) {
    throw new Error('Use a nonnegative latency and a positive integer size in MB.');
}
let file = args.find((arg) => !arg.startsWith('--'));
let folder = null;
if (!file) {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-benchmark-'));
    file = path.join(folder, 'synthetic.safetensors');
    const length = size * 1024 * 1024;
    const header = Buffer.from(JSON.stringify({ weight: { dtype: 'F32', shape: [length / 4], data_offsets: [0, length] } }));
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(header.length));
    fs.writeFileSync(file, Buffer.concat([prefix, header]));
    fs.truncateSync(file, 8 + header.length + length);
}
const fd = fs.openSync(file, 'r');
try {
    const length = fs.fstatSync(fd).size;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    let bytesRead = 0;
    let requests = 0;
    const source = {
        length,
        readSync(offset, bytes) {
            if (latency) {
                Atomics.wait(wait, 0, 0, latency);
            }
            requests++;
            bytesRead += bytes.length;
            let count = 0;
            while (count < bytes.length) {
                const read = fs.readSync(fd, bytes, count, bytes.length - count, offset + count);
                if (!read) {
                    throw new Error('Model was truncated.');
                }
                count += read;
            }
        }
    };
    const head = Buffer.alloc(Math.min(9, length));
    fs.readSync(fd, head, 0, head.length, 0);
    const kind = formatKind(file, head);
    if (!kind) {
        throw new Error('Benchmark supports binary ONNX, GGUF and Safetensors.');
    }
    // Warm compilation separately so the read comparison includes the same I/O conditions.
    const first = performance.now();
    const result = await indexSource(source, kind);
    const coldMs = performance.now() - first;
    const indexedBytes = bytesRead;
    const indexedRequests = requests;
    bytesRead = 0;
    requests = 0;
    const start = performance.now();
    const block = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
    for (let offset = 0; offset < length; offset += block.length) {
        source.readSync(offset, block.subarray(0, Math.min(block.length, length - offset)));
    }
    const fullMs = performance.now() - start;
    process.stdout.write(`${JSON.stringify({
        file, sizeBytes: length, latencyMsPerRead: latency,
        indexed: { coldMs, bytesRead: indexedBytes, requests: indexedRequests, metadataBytes: result.metadata.byteLength },
        fullScan: { ms: fullMs, bytesRead, requests },
        bytesAvoidedPercent: 100 * (1 - indexedBytes / length)
    }, null, 2)}\n`);
} finally {
    fs.closeSync(fd);
    if (folder) {
        fs.rmSync(folder, { recursive: true, force: true });
    }
}
