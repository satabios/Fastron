import * as assert from 'node:assert/strict';
import * as base from '../source/base.js';
import * as mock from './mock.js';
import * as view from '../source/view.js';
import { test } from 'node:test';

const context = (host, identifier, obj) => new mock.Context(host, '', identifier,
    new base.BinaryStream(new TextEncoder().encode(JSON.stringify(obj))));

test('simultaneous ONNX opens share metadata and examples requests', async () => {
    const onnx = await import('../source/onnx.js?metadata-concurrency');
    const host = new mock.Host({});
    const require = host.require.bind(host);
    host.require = (id) => id === './onnx' ? Promise.resolve(onnx) : require(id);
    const requests = [];
    host.request = async (name) => {
        requests.push(name);
        await Promise.resolve();
        if (name === 'onnx-metadata.slim.json') {
            return JSON.stringify([{ name: 'Add', module: 'ai.onnx', version: 1, category: 'Math' }]);
        }
        if (name === 'onnx-metadata-examples.json') {
            return JSON.stringify({ Add: [{ summary: 'Example', code: 'a + b' }] });
        }
        throw new Error(`Unexpected request '${name}'`);
    };
    const model = { irVersion: '8', graph: { node: [{ opType: 'Add', input: ['a', 'b'], output: ['c'] }] } };
    const service = new view.ModelFactoryService(host);
    const models = await Promise.all([
        service.open(context(host, 'a.onnx', model)),
        service.open(context(host, 'b.onnx', model))
    ]);
    assert.equal(requests.filter((name) => name === 'onnx-metadata.slim.json').length, 1);
    assert.equal(requests.filter((name) => name === 'onnx-metadata-examples.json').length, 1);
    for (const model of models) {
        assert.equal(model.modules[0].nodes[0].type.name, 'Add');
        assert.equal(model.modules[0].nodes[0].type.category, 'Math');
        assert.equal(model.modules[0].nodes[0].type.examples[0].code, 'a + b');
    }
});

test('simultaneous Keras opens share generic metadata and preserve fallback', async () => {
    const host = new mock.Host({});
    const requests = [];
    host.request = async (name) => {
        requests.push(name);
        await Promise.resolve();
        if (name === 'keras-metadata.slim.json') {
            throw new Error('Slim metadata unavailable');
        }
        if (name === 'keras-metadata.json') {
            return JSON.stringify([{ name: 'Dense', category: 'Layer' }]);
        }
        throw new Error(`File not found '${name}'`);
    };
    const model = { class_name: 'Sequential', config: { name: 'test', layers: [{ class_name: 'Dense', config: { name: 'dense', units: 2 } }] } };
    const service = new view.ModelFactoryService(host);
    const models = await Promise.all([
        service.open(context(host, 'a.json', model)),
        service.open(context(host, 'b.json', model))
    ]);
    assert.equal(requests.filter((name) => name === 'keras-metadata.slim.json').length, 1);
    assert.equal(requests.filter((name) => name === 'keras-metadata.json').length, 1);
    for (const model of models) {
        assert.equal(model.modules[0].nodes[0].type.name, 'Dense');
        assert.equal(model.modules[0].nodes[0].type.category, 'Layer');
    }
});

test('malformed shared metadata remains retryable on the next open', async () => {
    const freshView = await import('../source/view.js?metadata-retry');
    const host = new mock.Host({});
    let valid = false;
    host.request = async (name) => {
        if (name === 'keras-metadata.slim.json') {
            return valid ? JSON.stringify([{ name: 'Dense', category: 'Layer' }]) : 'malformed';
        }
        throw new Error(`File not found '${name}'`);
    };
    const model = { class_name: 'Sequential', config: { name: 'test', layers: [{ class_name: 'Dense', config: { name: 'dense', units: 2 } }] } };
    const service = new freshView.ModelFactoryService(host);
    await assert.rejects(service.open(context(host, 'retry.json', model)));
    valid = true;
    const result = await service.open(context(host, 'retry.json', model));
    assert.equal(result.modules[0].nodes[0].type.category, 'Layer');
});
