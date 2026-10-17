import * as assert from 'node:assert/strict';
import { NodeCatalog, nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { View } from '../source/view.js';
import { moduleBlocks } from '../source/module-blocks.js';
import { test } from 'node:test';

const fixture = () => {
    const type = { dataType: 'float32', shape: { dimensions: [8] } };
    const value = (name) => ({ name, type });
    const arg = (name, ...value) => ({ name, value });
    const first = value('input');
    const inputs = [arg('input', first)];
    const outputs = [];
    const nodes = [];
    let previous = first;
    for (let i = 0; i < 3; i++) {
        const cache = value(`cache_${i}`);
        const hidden = value(`hidden_${i}`);
        const output = value(`output_${i}`);
        inputs.push(arg(`cache_${i}`, cache));
        const weight = { name: `model.layers.${i}.weight`, type, initializer: { type, offset: i * 32, get values() {
            throw new Error('Weights must remain unread.');
        } } };
        nodes.push({ name: `/model/layers.${i}/self_attn/MatMul`, type: { name: 'MatMul' }, attributes: [],
            inputs: [arg('x', previous), arg('past', cache), arg('weight', weight)], outputs: [arg('hidden', hidden)] });
        nodes.push({ name: `/model/layers.${i}/mlp/Relu`, type: { name: 'Relu' }, attributes: [], inputs: [arg('x', hidden)], outputs: [arg('y', output)] });
        outputs.push(arg(`tap_${i}`, hidden));
        previous = output;
        if (i === 0) {
            previous = value('injected');
            nodes.push({ name: '/model/Add', type: { name: 'Add' }, attributes: [], inputs: [arg('x', output)], outputs: [arg('y', previous)] });
        }
    }
    outputs.push(arg('output', previous));
    return { nodes, inputs, outputs };
};

test('module scopes preserve every external input and intermediate output without asserting identical structure', async () => {
    const graph = fixture();
    Object.defineProperty(graph.nodes[0], 'attributes', { get() {
        throw new Error('Module grouping must not compare tensor payloads or attributes.');
    } });
    const analysis = await moduleBlocks(graph);
    const display = analysis.project();
    assert.equal(display.nodes.length, 4);
    assert.deepEqual(Array.from(display.nodes).slice(0, 3), graph.nodes.slice(0, 3), 'The singleton layer and injection remain explicit.');
    assert.deepEqual(analysis.groups.map((group) => group.blocks.map((block) => block.index)), [[1, 2]]);
    assert.equal(analysis.groups[0].kind, 'module');
    assert.deepEqual(display.inputs.flatMap((arg) => arg.value), graph.inputs.flatMap((arg) => arg.value));
    assert.deepEqual(display.outputs.flatMap((arg) => arg.value), graph.outputs.flatMap((arg) => arg.value));
    const summary = display.nodes[3];
    assert.deepEqual(summary.outputs.map((arg) => arg.value[0].name), ['hidden_1', 'hidden_2', 'output_2']);
    assert.equal(summary.type.name, 'layers');
    assert.equal(summary.type.type, 'function');
    assert.equal(graph.nodes.length, 7);
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    assert.equal(await view._repeatedPresentation(graph, () => true), graph);
    view.options.foldRepeatedBlocks = true;
    assert.equal((await view._repeatedPresentation(graph, () => true)).nodes.length, 4);
    const expanded = analysis.project(new Map(), new Set(analysis.groups.map((group) => group.id)));
    assert.deepEqual(Array.from(expanded.nodes, (node) => node._originalNode || node), graph.nodes);
});

test('module selection and nested graphs materialize only the requested real instance', async () => {
    const graph = fixture();
    let created = 0;
    const catalog = new NodeCatalog(graph.nodes, (node) => {
        created++;
        return node;
    }, (node) => node);
    graph.nodes = catalog.nodes;
    const analysis = await moduleBlocks(graph);
    const display = analysis.project(new Map([[0, 1]]));
    assert.equal(created, 0);
    const selected = display.nodes[3].type;
    assert.equal(selected._moduleScope, '/model/layers.2');
    assert.equal(selected.nodes[0].inputs[2].value[0].initializer.offset, 64);
    assert.equal(created, 1);
    assert.equal(await moduleBlocks(selected), null, 'Opening an instance must reach real operators without wrapping non-repeated child scopes.');
    assert.deepEqual(Array.from(nodeDescriptions(selected), (node) => node.type.name), ['MatMul', 'Relu']);
    assert.equal(created, 1);
    assert.equal(nodeCatalog(selected.nodes).cache.size, 1);
    assert.deepEqual(analysis.locate({ name: 'model.layers.2.weight' }), { group: analysis.groups[0], index: 1 });
    const dotted = fixture();
    dotted.nodes.forEach((node) => {
        node.name = node.name.replace(/^\//, '').replaceAll('/', '.');
    });
    const dottedAnalysis = await moduleBlocks(dotted);
    assert.equal(await moduleBlocks(dottedAnalysis.project().nodes[3].type), null, 'Dot-separated scopes must reach operators without recursive wrappers.');
});

test('only repeated indexed blocks fold; standalone embedding scopes and isolated layers retain their operators', async () => {
    const graph = fixture();
    graph.nodes[0].name = '/visual/patch_embed/Conv';
    graph.nodes[1].name = '/visual/patch_embed/Transpose';
    graph.nodes[2].name = '/visual/pos_embed/Gather';
    const analysis = await moduleBlocks(graph);
    assert.deepEqual(analysis.groups.map((group) => group.blocks.map((block) => block.index)), [[1, 2]]);
    assert.deepEqual(Array.from(analysis.project().nodes).slice(0, 3), graph.nodes.slice(0, 3));
    graph.nodes[5].name = '/visual/blocks.0/MatMul';
    graph.nodes[6].name = '/visual/blocks.0/Relu';
    assert.equal(await moduleBlocks(graph), null, 'Different families with one instance each are not repetitions.');
});

test('module grouping rejects unsorted dependencies, duplicate producers, control dependencies and unnamed graphs', async () => {
    const unsorted = fixture();
    unsorted.nodes[0].inputs.push(unsorted.outputs.at(-1));
    assert.equal(await moduleBlocks(unsorted), null);
    const duplicate = fixture();
    duplicate.nodes[1].outputs = duplicate.nodes[0].outputs;
    assert.equal(await moduleBlocks(duplicate), null);
    const controlled = fixture();
    controlled.nodes[1].controlDependencies = [{ name: 'control' }];
    assert.equal(await moduleBlocks(controlled), null);
    const nested = fixture();
    nested.nodes[0]._hasSubgraphs = true;
    assert.equal(await moduleBlocks(nested), null);
    const weights = fixture();
    weights.nodes.forEach((node) => {
        node.outputs = [];
    });
    assert.equal(await moduleBlocks(weights), null);
    const unnamed = fixture();
    unnamed.nodes.forEach((node) => {
        node.name = '';
    });
    assert.equal(await moduleBlocks(unnamed), null);
    assert.equal(await moduleBlocks(fixture(), () => false), null);
});

test('finding an operator in a module summary expands its real group even for the selected instance', async () => {
    const graph = fixture();
    const analysis = await moduleBlocks(graph);
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    view._path = [{ target: graph }];
    view._options.foldRepeatedBlocks = true;
    view._target = { _table: new Map() };
    const state = { analysis, selected: new Map(), expanded: new Set() };
    view._repeatStates.set(graph, state);
    let updates = 0;
    view._updateTarget = async () => {
        updates++;
    };
    await view.revealRepeated(graph.nodes[3]);
    assert.equal(updates, 1);
    assert.equal(state.expanded.has(0), true);
    assert.equal(analysis.project(state.selected, state.expanded).nodes.length, graph.nodes.length);
});
