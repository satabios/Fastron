import * as assert from 'node:assert/strict';
import { Graph, View } from '../source/view.js';
import { NodeCatalog, nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { Node } from '../source/grapher.js';
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

test('interleaved module inventories do not offer unsafe inline expansion', async () => {
    const type = { dataType: 'float32', shape: { dimensions: [8] } };
    const arg = (name) => ({ name, value: [{ name, type }] });
    const input = arg('input');
    const nodes = [0, 1, 0, 1].map((block, index) => ({ name: `/model/layers.${block}/op${index}`, type: { name: 'Relu' },
        inputs: [input], outputs: [arg(`out${index}`)] }));
    const graph = { nodes, inputs: [input], outputs: nodes.flatMap((node) => node.outputs) };
    const analysis = await moduleBlocks(graph);
    const group = analysis.groups[0];
    assert.equal(analysis.canExpandInline(group), false);
    assert.equal(analysis.project(new Map(), new Set(), new Map([[group.id, new Set([0])]])).nodes.length, 1);
});

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

for (const dotted of [false, true]) {
    test(`opened blocks group exported attention/MLP scopes without repetition badges (${dotted ? 'dot' : 'slash'} paths)`, async () => {
        const scope = dotted ? 'visual.blocks.0' : '/visual/blocks.0';
        const name = (relative) => `${scope}${dotted ? '.' : '/'}${dotted ? relative.replaceAll('/', '.') : relative}`;
        const value = (name) => ({ name });
        const input = value('input');
        let previous = input;
        const nodes = [];
        const add = (relative, type) => {
            const output = value(relative);
            nodes.push({ name: name(relative), type: { name: type }, inputs: [{ name: 'x', value: [previous] }], outputs: [{ name: 'y', value: [output] }] });
            previous = output;
        };
        add('norm1/LayerNormalization', 'LayerNormalization');
        add('attn/qkv/MatMul', 'MatMul');
        const tap = previous;
        add('attn/Softmax', 'Softmax');
        add('attn/proj/MatMul', 'MatMul');
        add('Add', 'Add');
        nodes.at(-1).inputs[0].value.push(input);
        add('norm2/LayerNormalization', 'LayerNormalization');
        add('mlp/linear_fc1/MatMul', 'MatMul');
        add('mlp/act_fn/Gelu', 'Gelu');
        add('mlp/linear_fc2/MatMul', 'MatMul');
        add('Add_1', 'Add');
        nodes.at(-1).inputs[0].value.push(nodes[4].outputs[0].value[0]);
        const graph = { name: 'block 0', nodes, inputs: [{ name: 'input', value: [input] }],
            outputs: [{ name: 'output', value: [previous] }, { name: 'tap', value: [tap] }], _moduleScope: scope };
        Object.defineProperty(nodes[1], 'attributes', { get() {
            throw new Error('Module grouping must not read attributes or weights.');
        } });
        const analysis = await moduleBlocks(graph);
        const display = analysis.project();
        assert.deepEqual(analysis.groups.map((group) => group.title), ['attn', 'mlp']);
        assert.equal(display.nodes.length, 6);
        assert.equal(display.nodes[0], nodes[0], 'Single-operator normalization modules remain real operators.');
        assert.equal(display.nodes[2], nodes[4], 'Residual additions remain explicit.');
        assert.equal(display.nodes[5], nodes[9]);
        assert.equal(display.nodes.some((node) => node._repeatHeader), false, 'Semantic groups must never acquire ×1 stack badges.');
        const attention = display.nodes[1];
        assert.equal(attention.type.nodes.length, 3);
        assert.deepEqual(attention.outputs.map((arg) => arg.value[0].name), ['attn/qkv/MatMul', 'attn/proj/MatMul']);
        assert.equal(await moduleBlocks(attention.type), null, 'Single-operation projections remain visible without recursive wrappers.');
        const expanded = analysis.project(new Map(), new Set([0]));
        assert.equal(expanded.nodes.length, 8);
        assert.equal(expanded.nodes.some((node) => node._repeatHeader), false);
        assert.equal(await moduleBlocks({ ...graph, _moduleScope: '' }), null, 'Standalone scopes in the main graph remain unfolded.');
    });
}

test('individual stack controls expand and fold one group while preserving other stacks and focusing its header', async () => {
    const value = (name) => ({ name, type: { dataType: 'float32', shape: { dimensions: [8] } } });
    const first = value('input');
    let previous = first;
    const graph = { nodes: [], inputs: [{ name: 'input', value: [first] }], outputs: [] };
    for (const family of ['encoder', 'decoder']) {
        for (let i = 0; i < 2; i++) {
            const output = value(`${family}_${i}`);
            graph.nodes.push({ name: `/${family}/layers.${i}/Relu`, type: { name: 'Relu' }, attributes: [],
                inputs: [{ name: 'x', value: [previous] }], outputs: [{ name: 'y', value: [output] }] });
            previous = output;
        }
    }
    graph.outputs.push({ name: 'output', value: [previous] });
    const analysis = await moduleBlocks(graph);
    assert.equal(analysis.groups.length, 2);
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    view._path = [{ target: graph }];
    view.options.foldRepeatedBlocks = true;
    const state = { analysis, selected: new Map(), expanded: new Set() };
    view._repeatStates.set(graph, state);
    view.show = () => {};
    let focused = null;
    view._updateTarget = async () => {
        view._target = { _displayGraph: analysis.project(state.selected, state.expanded), scrollToValue(node) {
            focused = node;
        } };
    };
    await view.toggleRepeatedBlock(analysis.groups[0]);
    assert.deepEqual([...state.expanded], [0]);
    assert.equal(view._target._displayGraph.nodes.length, 3);
    assert.equal(focused._repeatGroup, analysis.groups[0]);
    await view.toggleRepeatedBlock(analysis.groups[1]);
    await view.toggleRepeatedBlock(analysis.groups[0]);
    assert.deepEqual([...state.expanded], [1]);
    assert.equal(view._target._displayGraph.nodes.length, 3);
    assert.equal(focused._repeatGroup, analysis.groups[0]);
    assert.equal(view.options.foldRepeatedBlocks, true);
    await view.toggleRepeatedBlock({ id: 1 });
    assert.deepEqual([...state.expanded], [1], 'Stale or unrelated group controls cannot change the current graph.');
});

test('stack header buttons expose their state and support keyboard activation', () => {
    const host = new Host({ serial: true });
    const entry = new Node.Header.Entry(null, ['node-item-repeat-toggle'], 'Expand stack', 'Expand these instances.');
    entry.expanded = false;
    let clicks = 0;
    entry.on('click', () => clicks++);
    const create = host.document.createElementNS.bind(host.document);
    const events = new Map();
    host.document.createElementNS = (...args) => {
        const element = create(...args);
        element.addEventListener = (name, callback) => events.set(name, callback);
        return element;
    };
    try {
        entry.build(host.document, host.document.body);
        assert.equal(entry.element.getAttribute('role'), 'button');
        assert.equal(entry.element.getAttribute('tabindex'), '0');
        assert.equal(entry.element.getAttribute('aria-label'), 'Expand stack');
        assert.equal(entry.element.getAttribute('aria-expanded'), 'false');
        for (const key of ['Enter', ' ', 'Escape']) {
            let prevented = false;
            events.get('keydown')({ key, preventDefault() {
                prevented = true;
            }, stopPropagation() {} });
            assert.equal(prevented, key !== 'Escape');
        }
        assert.equal(clicks, 2);
    } finally {
        host.document.createElementNS = create;
    }
});

for (const gap of [false, true]) {
    test(`folded stack cards preview ${gap ? 'gapped' : 'consecutive'} indices from descriptors and preserve geometry through overview and release`, async () => {
        const graph = fixture();
        if (gap) {
            graph.nodes[5].name = graph.nodes[5].name.replace('layers.2', 'layers.4');
            graph.nodes[6].name = graph.nodes[6].name.replace('layers.2', 'layers.4');
            const hidden = graph.nodes[5].outputs[0].value[0];
            const residual = { ...hidden, name: 'residual' };
            graph.nodes[6].inputs[0].value = [residual];
            graph.nodes.splice(6, 0, { name: '/model/layers.4/Add', type: { name: 'Add' }, attributes: [],
                inputs: [{ name: 'x', value: [hidden] }], outputs: [{ name: 'y', value: [residual] }] });
        }
        Object.defineProperty(graph.nodes[5], 'attributes', { get() {
            throw new Error('Preview must not read hidden attributes.');
        } });
        const created = [];
        const catalog = new NodeCatalog(graph.nodes, (node) => {
            created.push(node.name);
            return node;
        }, (node) => node);
        graph.nodes = catalog.nodes;
        const analysis = await moduleBlocks(graph);
        const host = new Host({ serial: true });
        const view = new View(host);
        view.model = { modules: [graph] };
        view._path = [{ target: graph }];
        const state = { analysis, selected: new Map([[0, 1]]), expanded: new Set() };
        view._repeatStates.set(graph, state);
        const display = analysis.project(state.selected);
        const ui = new Graph(view, false);
        ui.add(display);
        ui.build(host.document);
        await ui.measure();
        const card = [...ui.nodes.values()].map((entry) => entry.label).find((node) => node._stackDepth);
        const preview = card._blocks.find((block) => block._items?.some((item) => item.name === 'Blocks'));
        assert.deepEqual(preview._items.map((item) => [item.name, item.content]), [
            ['Blocks', gap ? '1, 4' : '1–2'], ['Preview', `${gap ? '4 · 3' : '2 · 2'} ops`], ['Inside', 'self_attn · mlp']
        ]);
        assert.ok(preview._items.every((item) => item.separator === ': '));
        assert.equal(created.some((name) => /layers\.[124]\//.test(name)), false, 'Preview must not materialize hidden rich nodes.');
        card.x = 0;
        card.y = 0;
        card.layout();
        card.update();
        assert.equal(card._stackPaths.length, 1);
        assert.equal(card._blocks[0].y, 4);
        const size = [card.width, card.height];
        card.measure();
        assert.deepEqual([card.width, card.height], size, 'Repeated measurement must not accumulate stack padding.');
        card.release();
        assert.equal(card._stackPaths, null);
        card.buildOverview(host.document, host.document.body);
        card.updateOverview();
        assert.equal(card._stackPaths.length, 1);
        assert.equal(card._overviewText.textContent, '×2 layers');
        assert.deepEqual([card.width, card.height], size);
        card.release();
    });
}

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
