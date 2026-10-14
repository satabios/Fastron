// Run: node test/benchmark-loading.mjs [model path] [--latency=10] [--size=256] [--fixture=scattered-onnx|contiguous-onnx|large-gguf]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatKind, indexSource } from '../source/model-index.mjs';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const option = (name, fallback) => Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const latency = option('latency', 0);
const size = option('size', 256);
const fixture = args.find((arg) => arg.startsWith('--fixture='))?.split('=')[1] ?? 'safetensors';
if (!Number.isFinite(latency) || latency < 0 || !Number.isSafeInteger(size) || size < 1) {
    throw new Error('Use a nonnegative latency and a positive integer size in MB.');
}
let file = args.find((arg) => !arg.startsWith('--'));
let folder = null;
if (!file) {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-benchmark-'));
    const length = size * 1024 * 1024;
    const varint = (value) => {
        const bytes = [];
        do {
            bytes.push((value % 128) | (value >= 128 ? 128 : 0));
            value = Math.floor(value / 128);
        } while (value);
        return Buffer.from(bytes);
    };
    const field = (id, length) => Buffer.concat([varint(id * 8 + 2), varint(length)]);
    const uint64 = (value) => {
        const bytes = Buffer.alloc(8);
        bytes.writeBigUInt64LE(BigInt(value));
        return bytes;
    };
    if (fixture === 'scattered-onnx') {
        file = path.join(folder, 'synthetic.onnx');
        const tensors = 128;
        const payload = Math.floor(length / tensors);
        const tensor = Buffer.concat([Buffer.from([8, 2, 16, 1]), field(9, payload)]);
        const tensorSize = tensor.length + payload;
        const prefix = field(5, tensorSize);
        const header = Buffer.concat([Buffer.from([8, 9]), field(7, tensors * (prefix.length + tensorSize))]);
        const output = fs.openSync(file, 'w');
        try {
            fs.writeSync(output, header);
            for (let i = 0; i < tensors; i++) {
                fs.writeSync(output, prefix, 0, prefix.length, header.length + i * (prefix.length + tensorSize));
                fs.writeSync(output, tensor, 0, tensor.length, header.length + i * (prefix.length + tensorSize) + prefix.length);
            }
            fs.ftruncateSync(output, header.length + tensors * (prefix.length + tensorSize));
        } finally {
            fs.closeSync(output);
        }
    } else if (fixture === 'contiguous-onnx') {
        file = path.join(folder, 'synthetic.onnx');
        const header = Buffer.concat([Buffer.from([8, 9]), field(2, length)]);
        fs.writeFileSync(file, header);
        fs.truncateSync(file, header.length + length);
    } else if (fixture === 'large-gguf') {
        file = path.join(folder, 'synthetic.gguf');
        const name = Buffer.from('tokenizer.ggml.tokens');
        const token = Buffer.alloc(18750, 97);
        const tokens = Array.from({ length: 128 }, () => Buffer.concat([uint64(token.length), token]));
        const header = Buffer.concat([
            Buffer.from('GGUF'), Buffer.from([3, 0, 0, 0]), uint64(1), uint64(1),
            uint64(name.length), name, Buffer.from([9, 0, 0, 0, 8, 0, 0, 0]), uint64(tokens.length), ...tokens,
            uint64(1), Buffer.from('w'), Buffer.from([1, 0, 0, 0]), uint64(length / 4), Buffer.alloc(12)
        ]);
        fs.writeFileSync(file, header);
        fs.truncateSync(file, Math.ceil(header.length / 32) * 32 + length);
    } else if (fixture === 'safetensors') {
        file = path.join(folder, 'synthetic.safetensors');
        const header = Buffer.from(JSON.stringify({ weight: { dtype: 'F32', shape: [length / 4], data_offsets: [0, length] } }));
        fs.writeFileSync(file, Buffer.concat([uint64(header.length), header]));
        fs.truncateSync(file, 8 + header.length + length);
    } else {
        throw new Error(`Unknown fixture '${fixture}'.`);
    }
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
    // Cold indexing includes WASM compilation; the full scan runs afterward.
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
