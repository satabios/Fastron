import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { Reader } from '../source/text.js';
import { test } from 'node:test';

const metadataContext = (mode) => {
    const requests = [];
    return {
        requests,
        async request(name) {
            requests.push(name);
            if (name.endsWith('.slim.json') !== (mode === 'slim')) {
                throw new Error(`Asset omitted from ${mode} package: ${name}`);
            }
            return fs.readFile(new URL(`../source/${name}`, import.meta.url), 'utf8');
        }
    };
};

const openPnnx = async (mode) => {
    const { ModelFactory } = await import(`../source/ncnn.js?packaged-${mode}`);
    const content = '7767517\n3 2\npnnx.Input input 0 1 a\nnn.ReLU relu 1 1 a b\npnnx.Output output 1 0 b\n';
    const context = { ...metadataContext(mode), identifier: 'fixture.pnnx.param',
        async read() {
            return Reader.open(content);
        },
        async fetch() {
            throw new Error('No external weights');
        },
        set(type) {
            this.type = type;
            return type;
        }
    };
    const factory = new ModelFactory();
    assert.equal(await factory.match(context), 'pnnx.model');
    const model = await factory.open(context);
    assert.equal(model.format, 'PNNX');
    const graph = model.modules[0];
    assert.equal(graph.inputs[0].value[0].name, 'a');
    assert.equal(graph.outputs[0].value[0].name, 'b');
    assert.equal(graph.nodes[0].type.name, 'nn.ReLU');
    assert.equal(graph.nodes[0].type.category, 'Activation');
    return context.requests;
};

const openTengine = async (mode) => {
    const { ModelFactory } = await import(`../source/tengine.js?packaged-${mode}`);
    const context = { ...metadataContext(mode), value: {
        version: 2,
        async read() {},
        graphs: [{ id: 0, inputs: [], outputs: [],
            tensors: Array.from({ length: 4 }, (_, i) => ({ name: String(i), dataType: 0, dims: [1], type: 0 })),
            nodes: [{ name: 'conv', type: 'Convolution', version: 0, params: [3, 3, 1, 1], inputs: [0, 1, 2], outputs: [3] }]
        }]
    } };
    const model = await new ModelFactory().open(context);
    const node = model.modules[0].nodes[0];
    assert.equal(node.type.category, 'Layer');
    assert.deepEqual(node.inputs.map((input) => input.name), ['input', 'weight', 'bias']);
    assert.deepEqual(node.attributes.map(({ name, type, visible }) => ({ name, type, visible })), [
        { name: 'kernel_h', type: 'int32', visible: true },
        { name: 'kernel_w', type: 'int32', visible: true },
        { name: 'stride_h', type: 'int32', visible: false },
        { name: 'stride_w', type: 'int32', visible: false }
    ]);
    return context.requests;
};

test('PNNX text parser keeps categories when a package ships only slim metadata', async () => {
    assert.deepEqual(await openPnnx('slim'), ['pytorch-metadata.slim.json']);
});

test('Tengine model factory keeps typed attributes and port grouping with only slim metadata', async () => {
    assert.deepEqual(await openTengine('slim'), ['tengine-metadata.slim.json']);
});

test('custom metadata loaders preserve full-asset fallback', async () => {
    assert.deepEqual(await openPnnx('full'), ['pytorch-metadata.slim.json', 'pytorch-metadata.json']);
    assert.deepEqual(await openTengine('full'), ['tengine-metadata.slim.json', 'tengine-metadata.json']);
});
