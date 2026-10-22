import * as assert from 'node:assert/strict';
import * as base from '../source/base.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Graph, ModelFactoryService, View } from '../source/view.js';
import { NodeCatalog, nodeCatalog, nodeDescriptions, repeatedBlocks } from '../source/repeated-blocks.js';
import { Controller } from '../source/comparator.js';
import { Host } from './mock.js';
import { openSource } from '../source/model-source.mjs';
import { test } from 'node:test';
import { writeRepeatedModel } from './repeated-fixtures.mjs';

const type = { dataType: 'float32', shape: { dimensions: [8] } };
const value = (name) => ({ name, type });
const arg = (name, ...value) => ({ name, value });
const fixture = (count = 24) => {
    const nodes = [];
    let input = value('input');
    const first = input;
    for (let i = 0; i < count; i++) {
        const hidden = value(`hidden_${i}`);
        const output = value(`output_${i}`);
        const tensor = { type, get values() {
            throw new Error('Weights must remain unread.');
        } };
        nodes.push({ name: `encoder.layers.${i}.fc1`, type: { name: 'Linear' }, attributes: [], inputs: [arg('x', input), arg('weight', { name: `encoder.layers.${i}.weight`, type, initializer: tensor })], outputs: [arg('y', hidden)] });
        nodes.push({ name: `encoder.layers.${i}.activation`, type: { name: 'GELU' }, attributes: [], inputs: [arg('x', hidden)], outputs: [arg('y', output)] });
        input = output;
    }
    return { nodes, inputs: [arg('input', first)], outputs: [arg('output', input)] };
};

test('opening a model skips repetition analysis until folding is requested and reuses the result', async () => {
    const graph = fixture(3);
    let scans = 0;
    Object.defineProperty(graph.nodes[0], 'attributes', { get() {
        scans++;
        return [];
    } });
    const host = new Host({ serial: true });
    let saved = null;
    host.set = (name, options) => {
        saved = options;
    };
    host.delete = () => {
        saved = null;
    };
    const view = new View(host);
    const button = host.document.createElement('button');
    button.setAttribute('id', 'fold-repeated-blocks-button');
    host.document.body.appendChild(button);
    const model = { modules: [graph] };
    view.model = model;
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    view.target = { register() {}, unregister() {} };
    assert.equal(button.disabled, false);
    view._path = [{ target: graph }];
    view._reload = () => {};
    assert.equal(view.options.lazyRender, true);
    assert.equal(view.options.foldRepeatedBlocks, false);
    assert.equal(await view._repeatedPresentation(graph, () => true), graph);
    assert.equal(scans, 0);
    view.toggle('foldRepeatedBlocks');
    assert.equal(button.classList.contains('active'), true);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.title, 'Show Ungrouped Graph');
    assert.equal((await view._repeatedPresentation(graph, () => true)).nodes.length, 1);
    const scanned = scans;
    assert.ok(scanned > 0);
    view.toggle('names');
    assert.deepEqual(saved, { names: true }, 'Folding must not become a saved startup preference.');
    view.toggle('foldRepeatedBlocks');
    assert.equal(button.classList.contains('active'), false);
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(button.title, 'Group Model');
    assert.equal(await view._repeatedPresentation(graph, () => true), graph);
    view.toggle('foldRepeatedBlocks');
    assert.equal((await view._repeatedPresentation(graph, () => true)).nodes.length, 1);
    assert.equal(scans, scanned, 'Re-enabling folding must reuse verified metadata.');
    view.model = model;
    assert.equal(view.options.foldRepeatedBlocks, true, 'Redrawing the current model preserves the user choice.');
    view.model = { modules: [fixture(2)] };
    assert.equal(view.options.foldRepeatedBlocks, false, 'Every new model opens without a repetition scan.');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    view.target = null;
    assert.equal(button.disabled, true);
});

const dynamicFixture = (count = 3) => {
    const graph = fixture(count);
    const symbols = new Map();
    for (const node of graph.nodes) {
        for (const argument of [...node.inputs, ...node.outputs]) {
            for (const item of argument.value) {
                if (!item.initializer) {
                    if (!symbols.has(item.name)) {
                        symbols.set(item.name, `unk__${symbols.size}`);
                    }
                    item.type = { ...type, shape: { dimensions: [symbols.get(item.name), 8] } };
                }
            }
        }
    }
    return graph;
};

test('ONNX-generated dimension names can differ while repeated block shape relationships stay equal', async () => {
    const graph = dynamicFixture();
    const dimensions = graph.nodes.map((node) => node.outputs[0].value[0].type.shape.dimensions.slice());
    const analysis = await repeatedBlocks(graph);
    assert.equal(analysis.groups.length, 1);
    assert.equal(analysis.groups[0].blocks.length, 3);
    assert.equal(analysis.project().nodes.length, 2);
    assert.equal(analysis.project(new Map([[0, 2]])).nodes[0]._originalNode, graph.nodes[4]);
    for (const index of [0, 2]) {
        const selected = analysis.project(new Map([[0, index]]));
        for (let i = 0; i < selected.nodes.length; i++) {
            const source = graph.nodes[index * 2 + i];
            for (const direction of ['inputs', 'outputs']) {
                assert.deepEqual(selected.nodes[i][direction].flatMap((arg) => arg.value.map((value) => value.type.shape.dimensions)),
                    source[direction].flatMap((arg) => arg.value.map((value) => value.type.shape.dimensions)));
            }
        }
    }
    assert.deepEqual(graph.nodes.map((node) => node.outputs[0].value[0].type.shape.dimensions), dimensions);
});

test('symbol normalization preserves constraints, named and anonymous dimensions, and parameter bindings', async () => {
    for (const change of [
        (graph) => {
            graph.nodes[2].outputs[0].value[0].type.shape.dimensions[0] = graph.nodes[2].inputs[0].value[0].type.shape.dimensions[0];
        },
        (graph) => {
            graph.nodes[2].outputs[0].value[0].type.shape.dimensions[0] = 'batch';
        },
        (graph) => {
            graph.nodes[0].inputs[0].value[0].type.shape.dimensions[0] = null;
        },
        (graph) => {
            graph.nodes[2].outputs[0].value[0].type.shape.dimensions[0] = 16;
        },
        (graph) => {
            const weight = graph.nodes[0].inputs[1].value[0];
            weight.type = { ...type, shape: { dimensions: [graph.inputs[0].value[0].type.shape.dimensions[0], 8] } };
            graph.nodes[2].inputs[1].value[0] = weight;
        }
    ]) {
        const graph = dynamicFixture(2);
        change(graph);
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await repeatedBlocks(graph), null);
    }
});

test('a leading anonymous batch dimension stays separate from a repeated inferred-shape tail', async () => {
    const graph = dynamicFixture(4);
    graph.inputs[0].value[0].type.shape.dimensions[0] = null;
    const analysis = await repeatedBlocks(graph);
    assert.deepEqual(analysis.groups[0].blocks.map((block) => block.index), [1, 2, 3]);
    assert.equal(analysis.project().nodes.length, 4);
});

test('a folded stack retains its real boundary and per-instance parameters', async () => {
    const graph = fixture();
    const before = graph.nodes.slice();
    const repeats = await repeatedBlocks(graph);
    assert.equal(repeats.groups.length, 1);
    assert.equal(repeats.groups[0].blocks.length, 24);
    const folded = repeats.project();
    assert.equal(folded.nodes.length, 2);
    assert.equal(folded.nodes[0].inputs[0].value[0], graph.inputs[0].value[0]);
    assert.equal(folded.nodes[1].outputs[0].value[0], graph.outputs[0].value[0]);
    assert.equal(folded.nodes[0].outputs[0].value[0], folded.nodes[1].inputs[0].value[0]);
    const selected = repeats.project(new Map([[0, 17]]));
    assert.equal(selected.nodes[0]._originalNode, graph.nodes[34]);
    assert.equal(selected.nodes[0].inputs[1].value[0].name, 'encoder.layers.17.weight');
    assert.equal(selected.nodes[0].inputs[0].value[0], graph.inputs[0].value[0]);
    assert.equal(selected.nodes[1].outputs[0].value[0], graph.outputs[0].value[0]);
    assert.equal(repeats.project(new Map(), new Set([0])).nodes.length, 48);
    assert.deepEqual(graph.nodes, before);
    assert.deepEqual(repeats.locate(graph.nodes[34]), { group: repeats.groups[0], index: 17 });
});

test('changed middle layers split runs, and counts preserve gaps and modalities', async () => {
    const graph = fixture();
    graph.nodes[24].attributes.push({ name: 'epsilon', type: 'float32', value: 0.1 });
    const repeats = await repeatedBlocks(graph);
    assert.deepEqual(repeats.groups.map((group) => group.blocks.length), [12, 11]);
    assert.equal(repeats.project().nodes.length, 6);
    const sparse = fixture(3);
    sparse.nodes.splice(2, 2);
    assert.equal(await repeatedBlocks(sparse), null);
    const modalities = fixture(2);
    modalities.nodes[2].name = 'vision.blocks.0.fc1';
    modalities.nodes[3].name = 'vision.blocks.0.activation';
    assert.equal(await repeatedBlocks(modalities), null);
});

test('external taps, skipped connections, nested graphs and control flow stay unfolded', async () => {
    await Promise.all([
        (graph) => graph.outputs.push(arg('tap', graph.nodes[1].outputs[0].value[0])),
        (graph) => {
            graph.nodes[4].inputs[0].value[0] = graph.nodes[1].outputs[0].value[0];
        },
        (graph) => {
            graph.nodes[2].attributes = [{ name: 'body', type: 'graph', value: fixture(1) }];
        },
        (graph) => {
            graph.nodes[2].controlDependencies = [value('control')];
        }
    ].map(async (change) => {
        const graph = fixture(3);
        change(graph);
        const repeats = await repeatedBlocks(graph);
        assert.equal(repeats, null);
    }));
});

test('the lazy catalog retains array semantics without constructing every node', async () => {
    const graph = fixture(96);
    let created = 0;
    const catalog = new NodeCatalog(graph.nodes, (record) => {
        created++; return { ...record };
    }, (record) => record);
    graph.nodes = catalog.nodes;
    assert.equal(Array.isArray(graph.nodes), true);
    assert.equal(graph.nodes.length, 192);
    assert.equal(created, 0);
    const repeats = await repeatedBlocks(graph);
    assert.equal(created, 0);
    const overview = repeats.project();
    assert.equal(created, 0);
    assert.equal(overview.nodes[0]._originalNode, graph.nodes[0]);
    assert.equal(created, 1);
    assert.equal(graph.nodes[0], graph.nodes[0]);
    assert.equal(graph.nodes.map((node) => node.name).length, 192);
    assert.equal(created, 192);
    catalog.release();
    assert.equal(catalog.cache.size, 0);
    const selected = repeats.project(new Map([[0, 95]]));
    assert.equal(catalog.cache.size, 0);
    assert.equal(selected.nodes[0]._originalNode.name, 'encoder.layers.95.fc1');
    assert.equal(catalog.cache.size, 1);
});

test('analysis can be cancelled before publishing a partial index', async () => {
    const graph = fixture(256);
    assert.equal(await repeatedBlocks(graph, () => false), null);
    assert.equal((await repeatedBlocks(graph)).groups[0].blocks.length, 256);
});

test('verified repeat records retain indices instead of per-instance boundary maps and signatures', async () => {
    const graph = fixture(256);
    const analysis = await repeatedBlocks(graph);
    for (const group of analysis.groups) {
        assert.equal(group.external.length, 1);
        for (const block of group.blocks) {
            assert.deepEqual(Object.keys(block).sort(), ['index', 'indices']);
            assert.ok(block.indices instanceof Uint32Array);
        }
    }
    assert.deepEqual(analysis.locate({ name: 'hidden_217' }), { group: analysis.groups[0], index: 217 });
    assert.equal(analysis.project(new Map([[0, 217]])).nodes[0].inputs[1].value[0].name, 'encoder.layers.217.weight');
});

test('dtype, quantization, attributes and rewiring differences cannot be folded away', async () => {
    await Promise.all([
        (node) => {
            node.inputs[0].value[0].type = { ...type, dataType: 'float16' };
        },
        (node) => {
            node.inputs[1].value[0].quantization = { type: 'linear', scale: [0.1] };
        },
        (node) => {
            node.inputs[1].value[0].type = { ...type, shape: { dimensions: [9] } };
        },
        (node) => {
            node.attributes = [{ name: 'config', value: {} }];
        },
        (node) => {
            node.inputs[0].value[0] = value('unrelated');
        }
    ].map(async (change) => {
        const graph = fixture(2);
        graph.nodes[0].attributes = [{ name: 'config', value: [] }];
        graph.nodes[2].attributes = [{ name: 'config', value: [] }];
        change(graph.nodes[2]);
        assert.equal(await repeatedBlocks(graph), null);
    }));
});

test('shared initializers keep their identity and search descriptors allocate no nodes', async () => {
    const graph = fixture(3);
    const shared = graph.nodes[0].inputs[1].value[0];
    graph.nodes[2].inputs[1].value[0] = shared;
    graph.nodes[4].inputs[1].value[0] = shared;
    const catalog = new NodeCatalog(graph.nodes, (node) => ({ ...node }), (node) => node);
    graph.nodes = catalog.nodes;
    assert.equal(Array.from(nodeDescriptions(graph)).length, 6);
    assert.equal(catalog.cache.size, 0);
    const folded = (await repeatedBlocks(graph)).project(new Map([[0, 2]]));
    assert.equal(folded.nodes[0].inputs[1].value[0], shared);
});

test('folding preserves parameter sharing within each block without reading weights', async () => {
    for (const named of [true, false]) {
        const graph = fixture(2);
        for (let i = 0; i < graph.nodes.length; i++) {
            graph.nodes[i].type = { name: 'Add' };
        }
        const first = graph.nodes[0].inputs[1].value[0];
        const second = graph.nodes[2].inputs[1].value[0];
        if (!named) {
            first.name = '';
            second.name = '';
        }
        graph.nodes[1].inputs.push(arg('weight', { ...first }));
        graph.nodes[3].inputs.push(arg('weight', { ...second, name: named ? 'separate_weight' : '', initializer: { type,
            get values() {
                throw new Error('Weights must remain unread.');
            } } }));
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await repeatedBlocks(graph), null, 'Shared and independent parameters are different structure.');
        const matching = fixture(2);
        matching.nodes[1].inputs.push(arg('weight', { ...matching.nodes[0].inputs[1].value[0] }));
        matching.nodes[3].inputs.push(arg('weight', { ...matching.nodes[2].inputs[1].value[0] }));
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await repeatedBlocks(matching)).groups[0].blocks.length, 2);
    }
});

test('array mutations and freezing materialize a normal canonical array', () => {
    const catalog = new NodeCatalog([1, 2, 3], (n) => ({ n }), (n) => n);
    assert.deepEqual(Object.keys(catalog.nodes), ['0', '1', '2']);
    assert.deepEqual(catalog.nodes.splice(1, 1).map((v) => v.n), [2]);
    assert.equal(nodeCatalog(catalog.nodes), undefined);
    assert.deepEqual(catalog.nodes.map((v) => v.n), [1, 3]);
    const frozen = new NodeCatalog([1, 2], (n) => ({ n }), (n) => n).nodes;
    Object.freeze(frozen);
    assert.deepEqual(frozen.map((v) => v.n), [1, 2]);
    assert.throws(() => frozen.push({ n: 3 }), TypeError);
});

test('comparison still sees modifications in hidden instances', async () => {
    const a = fixture();
    const b = fixture();
    b.nodes[34].attributes.push({ name: 'epsilon', type: 'float32', value: 0.1 });
    a.nodes = new NodeCatalog(a.nodes, (node) => node, (node) => node).nodes;
    b.nodes = new NodeCatalog(b.nodes, (node) => node, (node) => node).nodes;
    assert.equal((await repeatedBlocks(a)).project().nodes.length, 2);
    const controller = Object.create(Controller.prototype);
    const state = controller._compareNodesPhase1(a, b);
    const result = await new Promise((resolve) => {
        controller._compareNodesPhase2(state, resolve);
    });
    assert.equal(result.pairs.length, 48);
    assert.equal(result.pairs.find((pair) => pair.indexA === 34).status, 'modified');
});

for (const format of ['safetensors', 'gguf', 'onnx']) {
    test(`${format}: expanded rendering retains model and UI objects only near the viewport`, async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-viewport-model-'));
        const host = new Host({ serial: true });
        const { file } = writeRepeatedModel(folder, format, 256);
        const context = await openSource(host, { path: file });
        try {
            const model = await new ModelFactoryService(host).open(context);
            const graph = model.modules[0];
            const analysis = await repeatedBlocks(graph);
            const display = analysis.project(new Map(), new Set([0]));
            const view = new View(host);
            view.model = model;
            const rendered = new Graph(view, display.groups);
            rendered.enableViewportCulling(true, 300);
            rendered.configureDeferredRendering({ detachInvisible: true, estimatedNodeSizeThreshold: 500 });
            rendered._detachedElementLimit = 4;
            rendered.add(display);
            const nodes = Array.from(rendered.nodes.values(), (entry) => entry.label).filter((node) => node._loadValue);
            assert.equal(nodes.length, 512);
            assert.ok(nodes.every((node) => !node._value && node._blocks.length === 0));
            assert.equal(nodeCatalog(graph.nodes).cache.size, 0);
            const before = await context.source.request('stats');
            rendered.build(host.document);
            await rendered.measure();
            assert.ok(nodes.every((node) => !node._value && node._blocks.length === 0));
            assert.equal(nodeCatalog(display.nodes).cache.size, 0);
            await rendered.layout(null);
            rendered.populateTiles();
            rendered.compactLayout();
            const geometry = nodes.map(({ x, y, width, height }) => [x, y, width, height]);
            const pan = (node) => {
                const delta = rendered.updateViewportVisibility({ x: node.x - 10, y: node.y - 10, width: 200, height: 150 });
                rendered.updateVisibleElements(host.document, delta);
            };
            pan(nodes[0]);
            assert.ok(nodes.some((node) => node._value && node._blocks.length));
            assert.ok(nodes.filter((node) => node._value).length < 512);
            pan(nodes[300]);
            pan(nodes[510]);
            assert.equal(nodes[0]._value, null);
            assert.equal(nodes[0]._blocks.length, 0);
            const descriptor = { name: nodes[0].id.slice('node-name-'.length), inputs: [] };
            view.showNodeProperties = (node) => assert.equal(node.name, descriptor.name);
            rendered.activate(descriptor);
            assert.ok(nodes[0]._value && nodes[0].element);
            await rendered.materializeAll(host.document);
            assert.ok(nodes.every((node) => node._value && node.element));
            rendered.select(null);
            rendered.hideAllNodes();
            rendered.resetViewportVisibility();
            pan(nodes[510]);
            assert.ok(nodes.filter((node) => node._value).length < 512);
            assert.deepEqual(nodes.map(({ x, y, width, height }) => [x, y, width, height]), geometry);
            assert.equal((await context.source.request('stats')).readBytes, before.readBytes);
        } finally {
            context.source.dispose();
            fs.rmSync(folder, { recursive: true, force: true });
        }
    });

    test(`${format}: indexed loading materializes one block and reads the selected instance's real bytes`, async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-repeated-'));
        const host = new Host({ serial: true });
        const { file } = writeRepeatedModel(folder, format);
        const context = await openSource(host, { path: file });
        try {
            const model = await new ModelFactoryService(host).open(context);
            const graph = model.modules[0];
            const catalog = nodeCatalog(graph.nodes);
            assert.ok(catalog);
            assert.equal(catalog.cache.size, 0);
            const analysis = await repeatedBlocks(graph);
            assert.ok(analysis);
            assert.equal(analysis.groups[0].blocks.length, 24);
            assert.equal(catalog.cache.size, 0);
            const folded = analysis.project(new Map([[0, 17]]));
            assert.equal(folded.nodes.length, 2);
            assert.equal(catalog.cache.size, 0);
            const view = new View(host);
            view.model = model;
            view._path = [{ target: graph }];
            let metrics = null;
            view._sidebar = { open: (sidebar) => {
                metrics = sidebar.metrics;
            } };
            view.showTargetProperties();
            assert.equal(metrics.find((metric) => metric.name === 'parameters').value,
                format === 'onnx' ? 24 * 1048576 : 48 * (1048576 + 4));
            assert.equal(catalog.cache.size, 0, 'Graph summaries must not materialize hidden nodes.');
            const tensor = folded.nodes[0].inputs.flatMap((arg) => arg.value).find((value) => value.initializer).initializer;
            const before = await context.source.request('stats');
            const preview = await tensor.preview(1);
            assert.deepEqual(new base.Tensor(preview.tensor, { skipWeights: false }).value, [170]);
            const after = await context.source.request('stats');
            assert.equal(after.readBytes - before.readBytes, 4);
            const all = analysis.project(new Map(), new Set([0]));
            assert.equal(all.nodes.length, 48);
            catalog.release();
            analysis.project();
            assert.equal(catalog.cache.size, 0);
            assert.equal((await context.source.request('stats')).readBytes, after.readBytes);
            await tensor.read();
            assert.equal(new DataView(tensor.values.buffer, tensor.values.byteOffset, 4).getFloat32(0, true), 170);
            const exportedBytes = (await context.source.request('stats')).readBytes - after.readBytes;
            assert.ok(exportedBytes >= 4 * 1024 * 1024 && exportedBytes < 4 * 1024 * 1024 + 256,
                'Full export reads the selected tensor, including its ONNX protobuf header.');
        } finally {
            context.source.dispose();
            fs.rmSync(folder, { recursive: true, force: true });
        }
    });
}
