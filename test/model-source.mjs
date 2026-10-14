import * as assert from 'node:assert/strict';
import * as base from '../source/base.js';
import * as fs from 'node:fs';
import * as mock from './mock.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as view from '../source/view.js';
import { openSource } from '../source/model-source.mjs';
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
