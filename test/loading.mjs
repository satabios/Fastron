import * as assert from 'node:assert/strict';
import * as base from '../source/base.js';
import * as fs from 'node:fs';
import * as mock from './mock.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as view from '../source/view.js';
import { FileStream } from '../source/node.js';
import { test } from 'node:test';

// Import the browser reader with only the platform surface its module needs.
globalThis.window = { document: { documentElement: { style: { scrollBehavior: 'auto' } } }, exports: {} };
await import('../source/browser.js');
const BrowserFileStream = window.exports.browser.FileStream;
delete globalThis.window;

const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-loading-'));
const file = path.join(folder, 'weights.bin');
fs.writeFileSync(file, bytes);
process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));

const readers = {
    browser: () => new BrowserFileStream([bytes.slice(0, 8), bytes.slice(8, 16), bytes.slice(16, 24), bytes.slice(24)], 8, 4, 0, bytes.length),
    desktop: () => {
        const stream = new FileStream(file, 0, bytes.length, fs.statSync(file).mtimeMs);
        stream._windowSize = 4;
        return stream;
    }
};

for (const [name, create] of Object.entries(readers)) {
    test(`${name}: exact reads across windows and chunk boundaries`, () => {
        const stream = create();
        try {
            assert.deepEqual(stream.peek(6), bytes.slice(0, 6));
            assert.equal(stream.position, 0);
            assert.deepEqual(stream.read(6), bytes.slice(0, 6));
            assert.deepEqual(stream.read(4), bytes.slice(6, 10));
            assert.deepEqual(stream.peek(), bytes.slice(10));
            assert.equal(stream.position, 10);
            assert.deepEqual(stream.read(), bytes.slice(10));
            assert.equal(stream.position, bytes.length);
            assert.deepEqual(stream.read(0), new Uint8Array(0));
            assert.deepEqual(stream.peek(0), new Uint8Array(0));
        } finally {
            stream.dispose?.();
        }
    });

    test(`${name}: substreams use relative positions`, () => {
        const parent = create();
        parent.seek(2);
        const stream = parent.stream(12);
        try {
            assert.equal(parent.position, 14);
            for (let index = 2; index < 14; index += 2) {
                assert.deepEqual(stream.read(2), bytes.slice(index, index + 2));
            }
            assert.deepEqual(stream.readAt(1, 9), bytes.slice(3, 12));
            assert.equal(stream.position, 12);
        } finally {
            parent.dispose?.();
            stream.dispose?.();
        }
    });

    test(`${name}: retained peek bytes survive window refills`, () => {
        const stream = create();
        try {
            const first = stream.peek(2);
            stream.seek(8);
            assert.deepEqual(stream.peek(2), bytes.slice(8, 10));
            assert.deepEqual(first, bytes.slice(0, 2));
        } finally {
            stream.dispose?.();
        }
    });

    test(`${name}: reject invalid ranges without moving the cursor`, () => {
        const stream = create();
        try {
            stream.seek(8);
            for (const length of [-1, 0.5, NaN, Infinity, 25]) {
                assert.throws(() => stream.peek(length));
                assert.equal(stream.position, 8);
                assert.throws(() => stream.read(length));
                assert.equal(stream.position, 8);
                assert.throws(() => stream.stream(length));
                assert.equal(stream.position, 8);
            }
            assert.throws(() => stream.skip(-9));
            assert.equal(stream.position, 8);
            assert.throws(() => stream.seek(33));
            assert.equal(stream.position, 8);
        } finally {
            stream.dispose?.();
        }
    });
}

test('explicit tensor loading overrides global metadata-only mode', () => {
    globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true, showTensorMetadata: true } };
    try {
        const data = new Uint8Array(new Float32Array([1.5, -2]).buffer);
        let reads = 0;
        const source = {
            name: 'weight', encoding: '<', type: { dataType: 'float32', shape: { dimensions: [2] } },
            get values() {
                reads++;
                return data;
            }
        };
        const skipped = new base.Tensor(source);
        assert.equal(skipped.data, null);
        assert.match(skipped.toString(), /float32/);
        assert.equal(reads, 0);
        const loaded = new base.Tensor(source, { skipWeights: false });
        assert.deepEqual(loaded.data, data);
        assert.deepEqual(loaded.value, [1.5, -2]);
        assert.match(loaded.toString(), /1\.5/);
        assert.equal(loaded.empty, false);
        assert.equal(window.NETRON_CONFIG.skipTensorWeights, true);
    } finally {
        delete globalThis.window;
    }
});

const varint = (value) => {
    const result = [];
    do {
        result.push((value & 127) | (value > 127 ? 128 : 0));
        value = Math.floor(value / 128);
    } while (value > 0);
    return Buffer.from(result);
};
const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field, value) => {
    value = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
};
const onnxModel = (tensor) => {
    const node = Buffer.concat([message(1, 'input'), message(1, 'weight'), message(2, 'output'), message(4, 'Add')]);
    const graph = Buffer.concat([message(1, node), message(5, tensor), message(11, message(1, 'input')), message(12, message(1, 'output'))]);
    return Buffer.concat([integer(1, 8), message(2, 'fastron'), message(7, graph)]);
};
const externalTensor = () => Buffer.concat([
    message(1, varint(2)), integer(2, 1), message(8, 'weight'), integer(14, 1),
    ...[['location', 'external.bin'], ['offset', '4'], ['length', '8']].map(([key, value]) => message(13, Buffer.concat([message(1, key), message(2, value)])))
]);

test('deferred external ONNX weights load in one request and preserve the graph', async () => {
    globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true, showTensorMetadata: true } };
    const streams = [];
    try {
        const raw = Buffer.alloc(16);
        raw.writeFloatLE(1.5, 4);
        raw.writeFloatLE(-2, 8);
        fs.writeFileSync(path.join(folder, 'external.bin'), raw);
        const host = new mock.Host({});
        const request = host.request.bind(host);
        let requests = 0;
        host.request = async (...args) => {
            if (args[0] === 'external.bin') {
                requests++;
            }
            const result = await request(...args);
            if (result instanceof FileStream) {
                streams.push(result);
            }
            return result;
        };
        const service = new view.ModelFactoryService(host);
        const context = new mock.Context(host, folder, 'model.onnx', new base.BinaryStream(onnxModel(externalTensor())));
        const model = await service.open(context);
        const graph = model.modules[0];
        assert.equal(graph.nodes.length, 1);
        assert.equal(graph.nodes[0].type.name, 'Add');
        assert.deepEqual(graph.inputs.map((arg) => arg.value[0].name), ['input']);
        assert.deepEqual(graph.outputs.map((arg) => arg.value[0].name), ['output']);
        const tensor = graph.nodes[0].inputs.flatMap((arg) => arg.value).find((value) => value.initializer).initializer;
        assert.equal(requests, 0);
        assert.equal(tensor.peek(), false);
        await tensor.read();
        streams.push(tensor._data);
        assert.equal(requests, 1);
        assert.equal(tensor.peek(), true);
        const loaded = new base.Tensor(tensor, { skipWeights: false });
        assert.deepEqual(loaded.value, [1.5, -2]);
        assert.match(loaded.toString(), /1\.5/);
        assert.deepEqual(tensor.type.shape.dimensions, [2]);
        await tensor.read();
        assert.equal(requests, 1);
        assert.equal(window.NETRON_CONFIG.skipTensorWeights, true);
    } finally {
        streams.forEach((stream) => stream.dispose?.());
        delete globalThis.window;
    }
});

test('deferred ONNX failures remain retryable', async () => {
    globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true } };
    try {
        const host = new mock.Host({});
        const request = host.request.bind(host);
        let attempts = 0;
        host.request = async (...args) => {
            if (args[0] === 'external.bin') {
                attempts++;
                if (attempts === 1) {
                    throw new Error('Network read failed');
                }
                const raw = Buffer.alloc(12);
                raw.writeFloatLE(1.5, 4);
                raw.writeFloatLE(-2, 8);
                return new base.BinaryStream(raw);
            }
            return request(...args);
        };
        const context = new mock.Context(host, folder, 'model.onnx', new base.BinaryStream(onnxModel(externalTensor())));
        const model = await new view.ModelFactoryService(host).open(context);
        const tensor = model.modules[0].nodes[0].inputs.flatMap((arg) => arg.value).find((value) => value.initializer).initializer;
        await assert.rejects(tensor.read(), /Network read failed/);
        assert.equal(tensor.peek(), false);
        await tensor.read();
        assert.deepEqual(new base.Tensor(tensor, { skipWeights: false }).value, [1.5, -2]);
        assert.equal(attempts, 2);
    } finally {
        delete globalThis.window;
    }
});

test('explicit sparse tensor loading also enables its values and indices', () => {
    globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true } };
    try {
        const child = (dataType, values) => ({ encoding: '|', type: { dataType, shape: { dimensions: [2] } }, values });
        const tensor = {
            encoding: '|', type: { dataType: 'float32', shape: { dimensions: [4] }, layout: 'sparse' },
            indices: child('int64', [1n, 3n]), values: child('float32', [1.5, -2])
        };
        assert.deepEqual(new base.Tensor(tensor, { skipWeights: false }).value, [0, 1.5, 0, -2]);
    } finally {
        delete globalThis.window;
    }
});

test('deferred file reads reject changed weights even with an open descriptor', () => {
    const changed = path.join(folder, 'changed.bin');
    fs.writeFileSync(changed, bytes);
    const stream = new FileStream(changed, 0, bytes.length, fs.statSync(changed).mtimeMs);
    try {
        stream.readAt(0, 2);
        fs.utimesSync(changed, new Date(), new Date(Date.now() + 10000));
        assert.throws(() => stream.readAt(0, 2), /last modified time changed/);
    } finally {
        stream.dispose();
    }
});

test('tensor metadata sidebar does not fetch disabled external weights for metrics', async () => {
    globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true } };
    try {
        let requests = 0;
        const tensor = {
            name: 'weight', encoding: '<', type: { dataType: 'float32', shape: { dimensions: [2] } },
            peek: () => false,
            read: async () => {
                requests++;
            }
        };
        const host = new mock.Host({});
        const context = { host, model: { attachment: { metadata: { tensor: () => [] } } } };
        const sidebar = new view.TensorSidebar(context, { value: [{ initializer: tensor }] });
        sidebar.render();
        await Promise.resolve();
        assert.equal(requests, 0);
    } finally {
        delete globalThis.window;
    }
});

test('tensor metrics do not fetch unloaded weights when weights are enabled', async () => {
    const host = new mock.Host({});
    const context = { host, model: { attachment: { metadata: { tensor: () => [] } } } };
    const tensor = {
        name: 'weight', encoding: '<', type: { dataType: 'float32', shape: { dimensions: [2] } },
        peek: () => false,
        read: async () => {
            throw new Error('Network read failed');
        }
    };
    const sidebar = new view.TensorSidebar(context, { value: [{ initializer: tensor }] });
    const errors = [];
    sidebar.error = (error) => errors.push(error.message);
    sidebar.render();
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    assert.deepEqual(errors, []);
});

for (const deferred of [false, true]) {
    test(`on-demand weight controls retry failures (deferred=${deferred})`, async () => {
        globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true, showTensorMetadata: true } };
        const host = new mock.Host({});
        const document = host.document;
        const createElement = document.createElement.bind(document);
        const events = new Map();
        document.createElement = (...args) => {
            const element = createElement(...args);
            const listeners = new Map();
            events.set(element, listeners);
            element.addEventListener = (name, callback, options) => listeners.set(name, { callback, options });
            element.removeEventListener = (name) => listeners.delete(name);
            return element;
        };
        try {
            let attempts = 0;
            let ready = false;
            const tensor = {
                name: 'weight', encoding: '<', type: { dataType: 'float32', shape: { dimensions: [2] } },
                peek: () => ready,
                read: async () => {
                    attempts++;
                    delete tensor._deferred;
                    if (attempts === 1) {
                        throw new Error('Network read failed');
                    }
                    ready = true;
                },
                get values() {
                    return new Uint8Array(new Float32Array([1.5, -2]).buffer);
                }
            };
            if (deferred) {
                tensor._deferred = {};
            }
            const context = { host, model: { attachment: { metadata: { tensor: () => [] } } } };
            const sidebar = new view.TensorSidebar(context, { value: [{ initializer: tensor }] });
            let entry = null;
            sidebar.addEntry = (name, item) => {
                if (name === 'value') {
                    entry = item;
                }
            };
            sidebar.render();
            const content = entry.content;
            assert.equal(attempts, 0);
            const click = async () => {
                const listener = events.get(content).get('click');
                assert.ok(listener);
                if (listener.options?.once) {
                    events.get(content).delete('click');
                }
                await listener.callback();
            };
            const pending = click();
            await click();
            await pending;
            assert.equal(attempts, 1);
            assert.match(content.textContent, /Click to retry/);
            await click();
            assert.equal(attempts, 2);
            assert.match(content.firstChild.innerHTML, /1\.5/);
            assert.equal(events.get(content).has('click'), false);
            assert.equal(window.NETRON_CONFIG.skipTensorWeights, true);
        } finally {
            document.createElement = createElement;
            delete globalThis.window;
        }
    });
}

test('view construction does not preload unrelated format decoders or metadata', async () => {
    await Promise.all(['Browser', 'Python'].map(async (type) => {
        const host = new mock.Host({ serial: true });
        Object.defineProperty(host, 'type', { value: type });
        const imports = [];
        const requests = [];
        host.require = async (id) => {
            imports.push(id);
        };
        host.request = async (id) => {
            requests.push(id);
        };
        const app = new view.View(host);
        assert.ok(app);
        await Promise.resolve();
        assert.deepEqual(imports, []);
        assert.deepEqual(requests, []);
    }));
});

test('file-backed GGUF skips payload buffering and retains exact tensor bytes', async () => {
    const ggufFile = path.join(folder, 'model.gguf');
    const u32 = (value) => {
        const buffer = Buffer.alloc(4);
        buffer.writeUInt32LE(value);
        return buffer;
    };
    const u64 = (value) => {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(BigInt(value));
        return buffer;
    };
    const name = Buffer.from('layer.weight');
    const header = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(1), u64(0), u64(name.length), name, u32(1), u64(2), u32(0), u64(0)]);
    const offset = Math.ceil(header.length / 32) * 32;
    const contents = Buffer.alloc(offset + 8);
    header.copy(contents);
    contents.writeFloatLE(1.5, offset);
    contents.writeFloatLE(-2, offset + 4);
    fs.writeFileSync(ggufFile, contents);
    fs.truncateSync(ggufFile, 64 * 1024 * 1024);
    const stat = fs.statSync(ggufFile);
    const stream = new FileStream(ggufFile, 0, stat.size, stat.mtimeMs);
    const read = stream._read.bind(stream);
    const ranges = [];
    let bytesRead = 0;
    stream._read = (buffer, start) => {
        bytesRead += buffer.length;
        ranges.push([start, buffer.length]);
        read(buffer, start);
    };
    let tensor = null;
    try {
        const host = new mock.Host({});
        const model = await new view.ModelFactoryService(host).open(new mock.Context(host, folder, 'model.gguf', stream));
        assert.equal(model.format, 'GGUF v3');
        assert.ok(bytesRead < stat.size, `Read ${bytesRead} of ${stat.size} bytes: ${JSON.stringify(ranges)}`);
        assert.ok(ranges.every(([, length]) => length <= stream.windowSize));
        tensor = model.modules[0].nodes[0].inputs[0].value[0].initializer;
        assert.deepEqual(new base.Tensor(tensor).value, [1.5, -2]);
    } finally {
        stream.dispose();
        tensor?._data?.dispose();
    }
});
