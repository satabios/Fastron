import * as assert from 'node:assert/strict';
import * as base from '../source/base.js';
import * as fs from 'node:fs';
import * as mock from './mock.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as view from '../source/view.js';
import { ModelSource, openSource } from '../source/model-source.mjs';
import { bufferedSource, fileVersion } from '../source/model-source-reader.mjs';
import { nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { MetadataIndexCache } from '../source/model-source-cache.mjs';
import { Worker } from 'node:worker_threads';
import { indexSource } from '../source/model-index.mjs';
import { pathToFileURL } from 'node:url';
import { patternBlocks } from '../source/pattern-blocks.js';
import { test } from 'node:test';

const varint = (value) => {
    const bytes = [];
    do {
        bytes.push((value & 127) | (value > 127 ? 128 : 0));
        value = Math.floor(value / 128);
    } while (value);
    return Buffer.from(bytes);
};
const field = (id, body) => {
    body = typeof body === 'string' ? Buffer.from(body) : body;
    return Buffer.concat([varint(id * 8 + 2), varint(body.length), body]);
};
const model = (tensor) => Buffer.concat([
    Buffer.from([8, 8]), field(2, 'fastron'),
    field(7, Buffer.concat([
        field(1, Buffer.concat([field(1, 'input'), field(1, 'weight'), field(2, 'output'), field(4, 'Add')])),
        field(5, tensor), field(11, field(1, 'input')), field(12, field(1, 'output'))
    ]))
]);
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-source-'));
process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));

test('native file versions normalize Windows device IDs without ignoring mutation or replacement', () => {
    const stat = { dev: 0n, ino: 10n, size: 20n, mtimeNs: 30n, ctimeNs: 40n };
    assert.equal(fileVersion(stat, 'win32'), fileVersion({ ...stat, dev: 3163522874n }, 'win32'));
    assert.notEqual(fileVersion(stat, 'linux'), fileVersion({ ...stat, dev: 1n }, 'linux'));
    for (const key of ['ino', 'size', 'mtimeNs', 'ctimeNs']) {
        assert.notEqual(fileVersion(stat, 'win32'), fileVersion({ ...stat, [key]: stat[key] + 1n }, 'win32'));
    }
});

test('metadata cache bounds bytes and entries, evicts LRU and owns transferred metadata', () => {
    const index = { kind: 1, metadata: new Uint8Array([8, 8]).buffer, ranges: [[0, 1, 2, 3]], key: 'file', name: 'file.onnx', length: 4, version: 'v1' };
    const cache = new MetadataIndexCache(4096, 2);
    cache.set('a', index);
    structuredClone(index.metadata, { transfer: [index.metadata] });
    assert.deepEqual(new Uint8Array(cache.get('a').metadata), new Uint8Array([8, 8]));
    index.metadata = new ArrayBuffer(2);
    cache.set('b', index);
    cache.get('a');
    cache.set('c', index);
    assert.equal(cache.get('b'), null);
    assert.ok(cache.get('a'));
    cache.set('a', { ...index, metadata: new ArrayBuffer(8192) });
    assert.equal(cache.get('a'), null);
    assert.ok(cache.get('c'));
    cache.set('c', { ...index, kind: 0 });
    assert.equal(cache.get('c'), null);
    const bounded = new MetadataIndexCache(300);
    bounded.set('a', index);
    bounded.set('b', index);
    assert.equal(bounded.get('a'), null);
    assert.ok(bounded.get('b'));
});

test('disposing during lazy native cache initialization never sends an obsolete open', async () => {
    let sent = 0;
    const source = new ModelSource({
        addEventListener() {},
        postMessage() {
            sent++;
        },
        terminate() {}
    });
    const pending = source.request('open', { input: { path: path.join(folder, 'cancelled.onnx') } });
    source.dispose();
    await assert.rejects(pending, /closed/);
    assert.equal(sent, 0);
});

test('native reopens reuse metadata across workers and invalidate changed or replaced files', async () => {
    const gguf = Buffer.alloc(24);
    gguf.write('GGUF');
    gguf.writeUInt32LE(3, 4);
    const fixtures = [
        ['cached.onnx', model(Buffer.concat([Buffer.from([8, 1, 16, 1]), field(8, 'weight'), field(9, Buffer.alloc(4))]))],
        ['cached.safetensors', Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 123, 125])],
        ['cached.gguf', gguf]
    ];
    for (const [name, bytes] of fixtures) {
        const file = path.join(folder, name);
        fs.writeFileSync(file, bytes);
        const open = () => openSource(new mock.Host({}), { path: file });
        // eslint-disable-next-line no-await-in-loop
        const first = await open();
        let metadata = null;
        try {
            // eslint-disable-next-line no-await-in-loop
            const stats = await first.source.request('stats');
            assert.equal(stats.indexCacheHits, 0);
            assert.ok(stats.readBytes > 0);
            metadata = Buffer.from(first.stream.peek(Math.min(first.stream.length, bytes.length)));
            first.stream.peek(1)[0] ^= 255;
        } finally {
            first.source.dispose();
        }
        // eslint-disable-next-line no-await-in-loop
        const second = await open();
        try {
            // eslint-disable-next-line no-await-in-loop
            assert.deepEqual(await second.source.request('stats'), { readBytes: 0, readRequests: 0, indexCacheHits: 1 });
            assert.deepEqual(Buffer.from(second.stream.peek(metadata.length)), metadata);
            // Cached models still reject invalid ranges and out-of-directory references.
            // eslint-disable-next-line no-await-in-loop
            await assert.rejects(second.source.request('index', { file: '../outside.bin' }));
        } finally {
            second.source.dispose();
        }
        fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
        // eslint-disable-next-line no-await-in-loop
        const changed = await open();
        try {
            // eslint-disable-next-line no-await-in-loop
            assert.equal((await changed.source.request('stats')).indexCacheHits, 0);
        } finally {
            changed.source.dispose();
        }
        const oldStat = fs.statSync(file);
        const replacement = `${file}.replacement`;
        fs.writeFileSync(replacement, bytes);
        fs.utimesSync(replacement, oldStat.atime, oldStat.mtime);
        fs.renameSync(replacement, file);
        // eslint-disable-next-line no-await-in-loop
        const replaced = await open();
        try {
            // eslint-disable-next-line no-await-in-loop
            assert.equal((await replaced.source.request('stats')).indexCacheHits, 0);
        } finally {
            replaced.source.dispose();
        }
        fs.rmSync(file);
        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(open(), /ENOENT/);
    }
});

test('cached metadata still checks descriptor identity before and after reuse', async () => {
    const file = path.join(folder, 'cached-guard.safetensors');
    fs.writeFileSync(file, Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 123, 125]));
    const first = await openSource(new mock.Host({}), { path: file });
    first.source.dispose();
    for (const failAt of [1, 2]) {
        const script = `
            import fs from 'node:fs';
            import { syncBuiltinESMExports } from 'node:module';
            import { parentPort } from 'node:worker_threads';
            const original = fs.fstatSync;
            let calls = 0;
            fs.fstatSync = (...args) => {
                const stat = original(...args);
                if (args[1]?.bigint && ++calls === ${failAt}) {
                    stat.mtimeNs += 1n;
                }
                return stat;
            };
            syncBuiltinESMExports();
            await import(${JSON.stringify(new URL('../source/model-source-worker.mjs', import.meta.url).href)});
            parentPort.postMessage({ ready: true });
        `;
        const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`));
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        const source = new ModelSource(worker);
        try {
            // eslint-disable-next-line no-await-in-loop
            await assert.rejects(source.request('open', { input: { path: file } }), /changed/);
        } finally {
            source.dispose();
        }
    }
});

test('native open resolves its initial path once and still canonicalizes referenced symlinks', async () => {
    const file = path.join(folder, 'canonical.safetensors');
    fs.writeFileSync(file, Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 123, 125]));
    const directory = path.join(folder, 'contained');
    fs.mkdirSync(directory);
    const initial = path.join(directory, 'initial.safetensors');
    fs.copyFileSync(file, initial);
    const script = `
        import fs from 'node:fs';
        import { parentPort } from 'node:worker_threads';
        const original = fs.promises.realpath;
        fs.promises.stat = async () => {
            throw new Error('Unexpected redundant path stat');
        };
        fs.promises.realpath = async (...args) => {
            parentPort.postMessage({ trace: 'realpath' });
            return original(...args);
        };
        await import(${JSON.stringify(new URL('../source/model-source-worker.mjs', import.meta.url).href)});
        parentPort.postMessage({ ready: true });
    `;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`));
    let resolutions = 0;
    worker.on('message', (message) => {
        if (message.trace) {
            resolutions++;
        }
    });
    const response = (predicate) => new Promise((resolve, reject) => {
        const receive = (message) => {
            if (predicate(message)) {
                worker.off('message', receive);
                worker.off('error', reject);
                resolve(message);
            }
        };
        worker.on('message', receive);
        worker.once('error', reject);
    });
    try {
        await response((message) => message.ready);
        const opened = response((message) => message.id === 1);
        worker.postMessage({ id: 1, command: 'open', input: { path: initial } });
        assert.equal((await opened).error, undefined);
        assert.equal(resolutions, 1);
        if (process.platform !== 'win32') {
            fs.symlinkSync(file, path.join(directory, 'escape.safetensors'));
            const denied = response((message) => message.id === 2);
            worker.postMessage({ id: 2, command: 'index', file: 'escape.safetensors' });
            assert.match((await denied).error, /outside its directory/);
            assert.equal(resolutions, 2);
        }
    } finally {
        await worker.terminate();
    }
});

test('native index read-ahead preserves bytes, bounds probes and retries failed reads', () => {
    const data = Uint8Array.from({ length: 20000 }, (_, i) => i % 251);
    const reads = [];
    let fail = false;
    const source = bufferedSource({
        length: data.length,
        readSync(offset, bytes) {
            if (fail) {
                throw new Error('Read failed');
            }
            reads.push([offset, bytes.length]);
            bytes.set(data.subarray(offset, offset + bytes.length));
        }
    });
    const read = (offset, length) => {
        const bytes = new Uint8Array(length);
        source.readSync(offset, bytes);
        assert.deepEqual(bytes, data.slice(offset, offset + length));
    };
    read(0, 9);
    read(1000, 256);
    read(1256, 512);
    read(1768, 1024);
    read(2792, 2048);
    read(10000, 256);
    assert.deepEqual(reads, [[0, 9], [1000, 256], [1256, 4096], [10000, 256]]);
    fail = true;
    assert.throws(() => read(10256, 512), /Read failed/);
    fail = false;
    read(10256, 512);
    read(19990, 10);
    read(20000, 0);
    assert.throws(() => read(-1, 1), /Invalid source range/);
    assert.throws(() => read(20000, 1), /Invalid source range/);
});

test('native indexing rejects directories without retaining their descriptor', async () => {
    const directory = path.join(folder, 'invalid.onnx');
    fs.mkdirSync(directory);
    await assert.rejects(openSource(new mock.Host({}), { path: directory }), /Invalid model file|EISDIR|EACCES|EPERM/);
    fs.rmdirSync(directory);
});

test('native read-ahead preserves ONNX metadata and tensor offsets while reducing sequential refills', async () => {
    const payload = Buffer.alloc(128 * 1024, 42);
    const tensors = Array.from({ length: 12 }, (_, i) => field(5, Buffer.concat([
        Buffer.from([8, 2, 16, 1]), field(9, payload), field(8, `weight.${i}`), field(12, Buffer.alloc(1700, 97))
    ])));
    const data = Buffer.concat([Buffer.from([8, 8]), field(7, Buffer.concat(tensors))]);
    const run = async (buffered) => {
        let calls = 0;
        let bytesRead = 0;
        const source = { length: data.length, readSync(offset, bytes) {
            calls++;
            bytesRead += bytes.length;
            bytes.set(data.subarray(offset, offset + bytes.length));
        } };
        return { result: await indexSource(buffered ? bufferedSource(source) : source, 1), calls, bytesRead };
    };
    const exact = await run(false);
    const buffered = await run(true);
    assert.deepEqual(buffered.result.metadata, exact.result.metadata);
    assert.deepEqual(buffered.result.ranges, exact.result.ranges);
    assert.ok(buffered.calls < exact.calls);
    assert.ok(buffered.bytesRead - exact.bytesRead < 4096 * tensors.length);
});

test('ONNX descriptors distinguish tensor headers from subgraphs and retain empty optional input slots', async () => {
    const type = field(1, Buffer.concat([Buffer.from([8, 1]), field(2, field(1, Buffer.from([8, 8])))]));
    const info = (name) => Buffer.concat([field(1, name), field(2, type)]);
    const tensor = Buffer.concat([field(1, varint(8)), Buffer.from([16, 1]), field(9, Buffer.alloc(32))]);
    const attribute = field(5, Buffer.concat([field(1, 'configuration'), field(5, tensor), varint(160), varint(4)]));
    const node = (input, output) => field(1, Buffer.concat([field(1, input), field(1, ''), field(2, output), field(4, 'Custom'), attribute]));
    const bytes = Buffer.concat([Buffer.from([8, 8]), field(8, Buffer.from([16, 13])), field(7, Buffer.concat([
        node('input', 'hidden'), node('hidden', 'output'), field(11, info('input')), field(12, info('output')), field(13, info('hidden'))
    ]))]);
    const file = path.join(folder, 'optional-attribute.onnx');
    fs.writeFileSync(file, bytes);
    const host = new mock.Host({ serial: true });
    const context = await openSource(host, { path: file });
    try {
        const graph = (await new view.ModelFactoryService(host).open(context)).modules[0];
        const nodes = [...nodeDescriptions(graph)];
        assert.deepEqual(nodes.map((n) => n.inputs.map((arg) => arg.value.length)), [[1, 0], [1, 0]]);
        assert.equal(nodes[0].attributes[0].type, 'tensor');
        assert.deepEqual(nodes[0].attributes[0].tensorTypes[0].shape.dimensions, [8]);
        assert.equal(Object.hasOwn(nodes[0].attributes[0], 'value'), false);
        const before = await context.source.request('stats');
        assert.deepEqual((await patternBlocks(graph)).groups.map((g) => g.blocks.length), [2]);
        assert.equal(nodeCatalog(graph.nodes).cache.size, 0);
        assert.equal((await context.source.request('stats')).readBytes, before.readBytes);
    } finally {
        context.source.dispose();
    }
});

test('a failed WASM load can retry without restarting the source worker', async () => {
    const directory = fs.mkdtempSync(path.join(folder, 'index-retry-'));
    const file = path.join(directory, 'model-index.mjs');
    fs.copyFileSync(new URL('../source/model-index.mjs', import.meta.url), file);
    const { indexSource } = await import(pathToFileURL(file));
    const header = Buffer.from('{}');
    const bytes = Buffer.alloc(8 + header.length);
    bytes.writeBigUInt64LE(BigInt(header.length));
    header.copy(bytes, 8);
    const source = { length: bytes.length, readSync: (offset, target) => target.set(bytes.subarray(offset, offset + target.length)) };
    const failed = await Promise.allSettled([indexSource(source, 3), indexSource(source, 3)]);
    assert.ok(failed.every((result) => result.status === 'rejected' && result.reason.code === 'ENOENT'));
    fs.writeFileSync(path.join(directory, 'model-index.wasm'), 'interrupted download');
    await assert.rejects(indexSource(source, 3), WebAssembly.CompileError);
    fs.copyFileSync(new URL('../source/model-index.wasm', import.meta.url), path.join(directory, 'model-index.wasm'));
    const indexed = await Promise.all([indexSource(source, 3), indexSource(source, 3)]);
    assert.ok(indexed.every((result) => result.kind === 3 && result.ranges.length === 0));
});

test('Rust indexing transfers topology and only a bounded ONNX preview', async () => {
    const weights = Buffer.alloc(8 * 1024 * 1024);
    weights.writeFloatLE(1.5, 0);
    weights.writeFloatLE(-2, 4);
    const tensor = Buffer.concat([field(1, varint(weights.length / 4)), Buffer.from([16, 1]), field(8, 'weight'), field(9, weights)]);
    const file = path.join(folder, 'model.onnx');
    fs.writeFileSync(file, model(tensor));
    const host = new mock.Host({});
    const context = await openSource(host, { path: file });
    try {
        assert.ok(context.stream.length < 1000);
        const graph = (await new view.ModelFactoryService(host).open(context)).modules[0];
        assert.equal(graph.nodes.length, 1);
        assert.equal(graph.nodes[0].type.name, 'Add');
        const initializer = graph.nodes[0].inputs.flatMap((arg) => arg.value).find((value) => value.initializer).initializer;
        assert.deepEqual(initializer.type.shape.dimensions, [weights.length / 4]);
        const before = await context.source.request('stats');
        assert.ok(before.readBytes < 131072);
        const preview = await initializer.preview(2);
        assert.deepEqual(new base.Tensor(preview.tensor, { skipWeights: false }).value, [1.5, -2]);
        assert.equal(preview.count, 2);
        assert.equal(preview.total, weights.length / 4);
        assert.equal(initializer.peek(), false);
        const after = await context.source.request('stats');
        assert.equal(after.readBytes - before.readBytes, 8);
        await initializer.read();
        assert.equal(initializer.peek(), true);
        assert.deepEqual(initializer.values.subarray(0, 8), new Uint8Array(weights.subarray(0, 8)));
    } finally {
        context.source.dispose();
    }
});

for (const [dataType, storageField, width, name] of [[1, 4, 4, 'float32'], [11, 10, 8, 'float64']]) {
    test(`packed ONNX ${name} preview stays bounded and NumPy export retains every value`, async () => {
        const count = 1048576;
        const weights = Buffer.alloc(count * width);
        const write = width === 4 ? 'writeFloatLE' : 'writeDoubleLE';
        for (let i = 0; i < 1000; i++) {
            weights[write](i / 4 - 128, i * width);
        }
        weights[write](7.25, weights.length - width);
        const tensor = Buffer.concat([field(1, varint(count)), Buffer.from([16, dataType]), field(8, 'weight'), field(storageField, weights)]);
        const file = path.join(folder, `packed-${name}.onnx`);
        fs.writeFileSync(file, model(tensor));
        const host = new mock.Host({});
        const context = await openSource(host, { path: file });
        try {
            assert.ok(context.stream.length < 1000);
            const graph = (await new view.ModelFactoryService(host).open(context)).modules[0];
            const initializer = graph.nodes[0].inputs.flatMap((arg) => arg.value).find((value) => value.initializer).initializer;
            const before = await context.source.request('stats');
            const preview = await initializer.preview();
            assert.ok(preview);
            assert.equal(preview.count, 1000);
            assert.equal(preview.total, count);
            assert.deepEqual(new base.Tensor(preview.tensor, { skipWeights: false }).value, Array.from({ length: 1000 }, (_, i) => i / 4 - 128));
            assert.equal((await context.source.request('stats')).readBytes - before.readBytes, 1000 * width);
            assert.equal(initializer.peek(), false);
            let exported = null;
            host.save = async () => `${name}.npy`;
            host.export = async (file, blob) => {
                exported = Buffer.from(await blob.arrayBuffer());
            };
            const sidebar = new view.TensorSidebar({ host, model: { attachment: { metadata: { tensor: () => [] } } } }, { value: [{ initializer }] });
            let entry = null;
            sidebar.addEntry = (name, item) => {
                if (name === 'value') {
                    entry = item;
                }
            };
            sidebar.render();
            entry._preview = preview;
            entry.error = (error) => {
                throw error;
            };
            await entry.export();
            assert.equal(initializer.peek(), true);
            assert.equal(initializer.values.length, count);
            assert.deepEqual(exported.subarray(0, 6), Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]));
            const headerSize = exported[6] === 1 ? exported.readUInt16LE(8) + 10 : exported.readUInt32LE(8) + 12;
            assert.deepEqual(exported.subarray(headerSize), weights);
        } finally {
            context.source.dispose();
        }
    });
}

test('unsupported ONNX typed storage does not fetch a speculative preview', async () => {
    const floats = field(4, Buffer.alloc(8));
    const variants = [
        [6, field(5, Buffer.from([1, 2]))],
        [8, field(6, 'value')],
        [1, Buffer.concat([Buffer.from([4 * 8 + 5]), Buffer.alloc(4)])],
        [1, Buffer.concat([floats, floats])],
        [1, Buffer.concat([field(9, Buffer.alloc(8)), floats])],
        [1, Buffer.concat([field(3, Buffer.from([8, 0, 16, 2])), floats])],
        [1, field(4, Buffer.alloc(3))],
        [11, floats]
    ];
    const host = new mock.Host({});
    for (const [i, [dataType, storage]] of variants.entries()) {
        const file = path.join(folder, `unsupported-${i}.onnx`);
        fs.writeFileSync(file, model(Buffer.concat([Buffer.from([8, 2, 16, dataType]), field(8, 'weight'), storage])));
        // eslint-disable-next-line no-await-in-loop
        const context = await openSource(host, { path: file });
        try {
            // eslint-disable-next-line no-await-in-loop
            const graph = (await new view.ModelFactoryService(host).open(context)).modules[0];
            const initializer = graph.nodes[0].inputs.flatMap((arg) => arg.value).find((value) => value.initializer).initializer;
            // eslint-disable-next-line no-await-in-loop
            const before = await context.source.request('stats');
            // eslint-disable-next-line no-await-in-loop
            assert.equal(await initializer.preview(), null, `Unsupported storage variant ${i}`);
            // eslint-disable-next-line no-await-in-loop
            assert.equal((await context.source.request('stats')).readBytes, before.readBytes);
            assert.equal(initializer.peek(), false);
        } finally {
            context.source.dispose();
        }
    }
});

test('Safetensors headers stay small and preview does not materialize the tensor', async () => {
    const header = Buffer.from(JSON.stringify({ weight: { dtype: 'F32', shape: [2097152], data_offsets: [0, 8388608] } }));
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(header.length));
    const bytes = Buffer.concat([prefix, header, Buffer.alloc(8388608)]);
    bytes.writeFloatLE(1.5, prefix.length + header.length);
    const file = path.join(folder, 'model.safetensors');
    fs.writeFileSync(file, bytes);
    const host = new mock.Host({});
    const context = await openSource(host, { path: file });
    try {
        const graph = (await new view.ModelFactoryService(host).open(context)).modules[0];
        const tensor = graph.nodes[0].inputs[0].value[0].initializer;
        const before = await context.source.request('stats');
        const preview = await tensor.preview(1);
        assert.deepEqual(new base.Tensor(preview.tensor, { skipWeights: false }).value, [1.5]);
        assert.equal((await context.source.request('stats')).readBytes - before.readBytes, 4);
        assert.equal(tensor.peek(), false);
    } finally {
        context.source.dispose();
    }
});

test('source reads reject mutation, path traversal, invalid ranges and cancellation', async () => {
    const file = path.join(folder, 'change.safetensors');
    const header = Buffer.from('{}');
    const bytes = Buffer.alloc(10);
    bytes.writeBigUInt64LE(2n);
    header.copy(bytes, 8);
    fs.writeFileSync(file, bytes);
    const context = await openSource(new mock.Host({}), { path: file });
    try {
        const ref = context.stream.descriptor;
        await assert.rejects(context.source.request('index', { file: '../outside.bin' }));
        await assert.rejects(context.source.request('read', { file: ref.key, version: ref.version, offset: -1, length: 1 }));
        fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
        await assert.rejects(context.stream.readAt(0, 1), /changed/);
        context.source.dispose();
        await assert.rejects(context.source.request('stats'), /closed/);
    } finally {
        context.source.dispose();
    }
});

test('indexed GGUF keeps file offsets and exact preview/full values', async () => {
    const integer = (value, size) => {
        const bytes = Buffer.alloc(size);
        if (size === 8) {
            bytes.writeBigUInt64LE(BigInt(value));
        } else {
            bytes.writeUInt32LE(value);
        }
        return bytes;
    };
    const u64 = (n) => integer(n, 8);
    const u32 = (n) => integer(n, 4);
    const name = Buffer.from('layer.weight');
    const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(0), u64(name.length), name, u32(1), u64(2), u32(0), u64(0)]);
    const offset = Math.ceil(header.length / 32) * 32;
    const bytes = Buffer.alloc(offset + 8);
    header.copy(bytes);
    bytes.writeFloatLE(1.5, offset);
    bytes.writeFloatLE(-2, offset + 4);
    const file = path.join(folder, 'indexed.gguf');
    fs.writeFileSync(file, bytes);
    fs.truncateSync(file, 8 * 1024 * 1024);
    const host = new mock.Host({});
    const context = await openSource(host, { path: file });
    try {
        assert.equal(context.stream.length, 8 * 1024 * 1024);
        const graph = (await new view.ModelFactoryService(host).open(context)).modules[0];
        const tensor = graph.nodes[0].inputs[0].value[0].initializer;
        const before = await context.source.request('stats');
        const preview = await tensor.preview(1);
        assert.deepEqual(new base.Tensor(preview.tensor, { skipWeights: false }).value, [1.5]);
        assert.equal((await context.source.request('stats')).readBytes - before.readBytes, 4);
        assert.equal(tensor.peek(), false);
        await tensor.read();
        assert.deepEqual(new base.Tensor(tensor, { skipWeights: false }).value, [1.5, -2]);
    } finally {
        context.source.dispose();
    }
});

test('sharded Safetensors opens headers through the pinned companion source', async () => {
    const file = path.join(folder, 'model.safetensors.index.json');
    fs.writeFileSync(file, JSON.stringify({ weight_map: { weight: 'model.safetensors' } }));
    const host = new mock.Host({});
    const context = await openSource(host, { path: file });
    try {
        const graph = (await new view.ModelFactoryService(host).open(context)).modules[0];
        const tensor = graph.nodes[0].inputs[0].value[0].initializer;
        assert.ok((await context.source.request('stats')).readBytes < 131072);
        assert.deepEqual(new base.Tensor((await tensor.preview(1)).tensor, { skipWeights: false }).value, [1.5]);
    } finally {
        context.source.dispose();
    }
});

test('previews reject packed/sparse/strided storage and do not read weights', async () => {
    let reads = 0;
    const source = { length: 32, readAt() {
        reads++; throw new Error('Unexpected payload read');
    } };
    const tensor = { type: { dataType: 'float32', shape: { dimensions: [2, 2] } }, stride: [1, 2], encoding: '<' };
    assert.equal(await base.Tensor.preview(tensor, source), null);
    tensor.stride = [2, 1];
    tensor.type.layout = 'sparse';
    assert.equal(await base.Tensor.preview(tensor, source), null);
    delete tensor.type.layout;
    tensor.type.dataType = 'float4e2m1fn';
    assert.equal(await base.Tensor.preview(tensor, source), null);
    tensor.type.dataType = 'float6e3m2fn';
    assert.equal(await base.Tensor.preview(tensor, source), null);
    tensor.type.dataType = 'float32';
    delete tensor.stride;
    tensor.type.shape.dimensions = [100];
    await assert.rejects(base.Tensor.preview(tensor, source), /range/);
    assert.equal(reads, 0);
});

test('failed graph replacement preserves the previous source until rollback', async () => {
    const old = { _source: { closed: false, dispose() {
        this.closed = true;
    } } };
    const next = { _source: { closed: false, dispose() {
        this.closed = true;
    } } };
    const state = {
        _model: old, _path: [],
        async _updatePath(model) {
            assert.equal(old._source.closed, false);
            this._model = model;
            if (model === next) {
                throw new Error('Layout failed');
            }
        }
    };
    await assert.rejects(view.View.prototype._updateTarget.call(state, next, []), /Layout failed/);
    assert.equal(state._model, old);
    assert.equal(old._source.closed, false);
    assert.equal(next._source.closed, true);
    next._source.closed = false;
    state._updatePath = async function(model) {
        this._model = model;
    };
    await view.View.prototype._updateTarget.call(state, next, []);
    assert.equal(old._source.closed, true);
    assert.equal(next._source.closed, false);
});
