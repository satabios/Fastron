import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Graph, ModelFactoryService, View } from '../source/view.js';
import { NodeCatalog, nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { hierarchyFixture, hierarchyModel } from './group-fixtures.mjs';
import { Host } from './mock.js';
import { graphGroups } from '../source/graph-groups.js';
import { openSource } from '../source/model-source.mjs';
import { test } from 'node:test';

test('grouping stays lazy, caches descriptors, and retains every boundary tensor and shape', async () => {
    const graph = hierarchyFixture();
    const canonical = graph.nodes;
    let descriptions = 0;
    const catalog = new NodeCatalog(canonical, () => {
        throw new Error('Grouping must not materialize operators.');
    }, (node) => {
        descriptions++;
        return node;
    });
    graph.nodes = catalog.nodes;
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    assert.equal(await view._groupedPresentation(graph, () => true), graph);
    assert.equal(descriptions, 0, 'The normal view pays no grouping cost.');
    view.options.foldRepeatedBlocks = true;
    const display = await view._groupedPresentation(graph, () => true);
    const state = view._groupStates.get(graph);
    assert.equal(display.nodes.length, 2, 'Initially show the first branching level.');
    const nodes = [...nodeDescriptions(display)];
    assert.deepEqual(nodes.map((node) => node.type.name), ['blocks.0', 'blocks.1']);
    assert.deepEqual(nodes[0].outputs.map((arg) => arg.name), ['tensor_3', 'tensor_6']);
    assert.equal(nodes[0].inputs[0].value[0], graph.inputs[0].value[0]);
    assert.equal(nodes[0].outputs[0].value[0], graph.outputs[0].value[0]);
    assert.equal(display.inputs, graph.inputs);
    assert.equal(display.outputs, graph.outputs);
    assert.equal(await view._groupedPresentation(graph, () => true), display, 'Unchanged views reuse the projection.');
    assert.equal(descriptions, canonical.length, 'Expansion uses the cached graph descriptions.');
    assert.equal(catalog.cache.size, 0);
    const expanded = state.analysis.project(new Set(state.analysis.groups.keys()));
    assert.deepEqual([...nodeDescriptions(expanded)].map((node) => node._originalNode), canonical);
});

test('exported scopes take precedence over names, including an explicit empty namespace', async () => {
    const graph = hierarchyFixture();
    graph.nodes.forEach((node, index) => {
        node._scope = index < 7 ? '//exported//first/' : 'exported/second';
    });
    const analysis = await graphGroups(graph);
    assert.ok(analysis.groups.has('/exported/first'));
    assert.ok(!analysis.groups.has('/network'));
    graph.nodes[0].group = 'native/group';
    graph.nodes[1].group = 'native/group';
    graph.nodes[2]._scope = '';
    const other = await graphGroups(graph);
    assert.equal(other.parents[0].id, '/native/group');
    assert.equal(other.parents[2], other.root);
});

test('interleaved scopes preserve original operator order when expanded', async () => {
    const graph = hierarchyFixture();
    graph.nodes.forEach((node, i) => {
        node._scope = i % 2 ? 'odd' : 'even';
        node.inputs = graph.inputs;
    });
    const analysis = await graphGroups(graph);
    assert.equal(analysis.project().nodes.length, 2);
    assert.deepEqual([...nodeDescriptions(analysis.project(new Set(analysis.groups.keys())))].map((node) => node._originalNode), graph.nodes);
});

test('scopes that would introduce cycles remain expanded and retain control dependencies', async () => {
    const graph = hierarchyFixture();
    graph.nodes = graph.nodes.slice(0, 3);
    graph.nodes.forEach((node, i) => {
        node._scope = i === 1 ? '' : 'reentered';
    });
    graph.outputs = graph.nodes[2].outputs;
    graph.nodes[2].controlDependencies = graph.nodes[1].outputs[0].value;
    const analysis = await graphGroups(graph);
    const display = analysis.project();
    assert.equal(display.nodes.length, 3);
    assert.equal(analysis.groups.get('/reentered').unsafe, true);
    assert.equal([...nodeDescriptions(display)][2].controlDependencies, graph.nodes[2].controlDependencies);
});

test('group boundaries include chained outputs and external control dependencies', async () => {
    const graph = hierarchyFixture();
    const chained = { name: 'chained', value: [{ name: 'chained', type: graph.inputs[0].value[0].type }] };
    graph.nodes[0].chain = [{ outputs: [chained] }];
    graph.nodes[1].inputs = [chained];
    graph.outputs.push(chained);
    graph.nodes[7].controlDependencies = graph.nodes[3].outputs[0].value;
    const analysis = await graphGroups(graph);
    const norm = analysis.boundary(analysis.groups.get('/network/blocks.0/norm'));
    assert.equal(norm.outputs[0].value[0], chained.value[0]);
    const second = analysis.boundary(analysis.groups.get('/network/blocks.1'));
    assert.deepEqual(second.controlDependencies, graph.nodes[7].controlDependencies);
});

for (const direction of ['vertical', 'horizontal']) {
    test(`nested ${direction} groups reserve header space and keep long symbolic shapes`, async () => {
        const graph = hierarchyFixture();
        const host = new Host({ serial: true });
        const view = new View(host);
        view.model = { modules: [graph] };
        view.options.foldRepeatedBlocks = true;
        view.options.direction = direction;
        view.options.layout = 'force';
        await view._groupedPresentation(graph, () => true);
        const state = view._groupStates.get(graph);
        state.expanded.add('/network/blocks.0');
        state.display = null;
        const display = await view._groupedPresentation(graph, () => true);
        const rendered = new Graph(view, true);
        rendered.add(display);
        rendered.build(host.document);
        await rendered.measure();
        await rendered.layout(null);
        rendered.update();
        assert.equal(rendered.options.layout, 'dagre');
        assert.equal(view.options.layout, 'force');
        const expected = 'batch×sequence_length×64';
        assert.ok([...rendered.edges.values()].some((edge) => edge.label.label === expected));
        const block = rendered._groupNodes.get('/network/blocks.0');
        const top = block.y - block.height / 2;
        assert.ok(block.headerElement);
        assert.ok(block.width >= block.headerWidth, 'The complete group title must fit.');
        for (const id of rendered.children(block.name)) {
            const child = rendered.node(id).label;
            assert.ok(child.y - child.height / 2 >= top + block.headerHeight, 'Headers cannot overlap children.');
            assert.ok(child.x - child.width / 2 >= block.x - block.width / 2);
        }
        const card = rendered._groupNodes.get('/network/blocks.0/attn');
        assert.equal(card._blocks[0]._entries[0].content, 'attn');
        const expand = card._blocks[0]._entries.at(-1);
        assert.equal(expand.element.getAttribute('aria-expanded'), 'false');
        let selected = null;
        view.toggleGraphGroup = async (group) => {
            selected = group;
        };
        expand.emit('click');
        assert.equal(selected.id, '/network/blocks.0/attn');
    });
}

test('bundled group connections retain all tensors for inspection, including unknown shapes', async () => {
    const graph = hierarchyFixture();
    graph.nodes[7].inputs.push(graph.nodes[0].outputs[0]);
    graph.nodes[0].outputs[0].value[0].type = null;
    const host = new Host({ serial: true });
    const view = new View(host);
    view.model = { modules: [graph] };
    view.options.foldRepeatedBlocks = true;
    const display = await view._groupedPresentation(graph, () => true);
    const rendered = new Graph(view, true);
    rendered.add(display);
    rendered.build(host.document);
    const edge = [...rendered.edges.values()].find((edge) => edge.label.groupValues.size === 2).label;
    assert.ok(edge.label.includes('?'));
    assert.ok(edge.label.includes('batch×sequence_length×64'));
    let inspected = null;
    view.showTensorProperties = (argument) => {
        inspected = argument.value;
    };
    edge.activate();
    assert.equal(inspected.length, 2);
});

test('finding a hidden operator expands only its ancestors', async () => {
    const graph = hierarchyFixture();
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    view._path = [{ target: graph }];
    view.options.foldRepeatedBlocks = true;
    await view._groupedPresentation(graph, () => true);
    let updates = 0;
    view._updateTarget = async () => {
        updates++;
    };
    await view.revealRepeated(graph.nodes[9]);
    const state = view._groupStates.get(graph);
    assert.ok(state.expanded.has('/network/blocks.1/attn'));
    assert.ok(!state.expanded.has('/network/blocks.0'));
    assert.equal(updates, 1);
    await view.revealRepeated(graph.nodes[9]);
    assert.equal(updates, 1);
});

test('disabling grouping during an expansion cannot reopen an obsolete group sidebar', async () => {
    const graph = hierarchyFixture();
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    view._path = [{ target: graph }];
    view.options.foldRepeatedBlocks = true;
    await view._groupedPresentation(graph, () => true);
    let finish = null;
    view._updateTarget = () => new Promise((resolve) => {
        finish = resolve;
    });
    view.showGraphGroup = () => assert.fail('A stale expansion cannot select a group.');
    const state = view._groupStates.get(graph);
    const pending = view.toggleGraphGroup(state.analysis.groups.get('/network/blocks.0'));
    view.options.foldRepeatedBlocks = false;
    finish();
    await pending;
    assert.equal(state.pending, null);
    assert.ok(!state.expanded.has('/network/blocks.1'));
});

test('expanding a distant group focuses its cached geometry even when its DOM is absent', async () => {
    const graph = hierarchyFixture();
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    view._path = [{ target: graph }];
    view.options.foldRepeatedBlocks = true;
    await view._groupedPresentation(graph, () => true);
    const state = view._groupStates.get(graph);
    const group = state.analysis.groups.get('/network/blocks.1');
    let focused = null;
    view._target = { _hierarchy: state.analysis, zoom: 1,
        _groupNodes: new Map([[group.id, { x: 200, y: 12000, width: 300, height: 600 }]]),
        _containerElement: { clientWidth: 800, clientHeight: 600 },
        _scrollToGraphBounds(bounds) {
            focused = bounds;
        } };
    view._updateTarget = async () => {};
    view.showGraphGroup = () => {};
    await view.toggleGraphGroup(group);
    assert.deepEqual(focused, { x: 50, y: 11700, width: 300, height: 480 });
    assert.ok(!state.expanded.has('/network/blocks.0'));
});

test('ONNX namespace metadata survives both lightweight and materialized loading', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'fastron-grouping-'));
    const file = path.join(folder, 'model.json');
    const obj = hierarchyModel();
    obj.graph.node.forEach((node, i) => {
        node.metadata_props = [{ key: 'namespace', value: i < 7 ? 'explicit/first' : 'explicit/second' }];
    });
    await fs.writeFile(file, JSON.stringify(obj));
    const host = new Host({ serial: true });
    const context = await openSource(host, { path: file });
    try {
        const model = await new ModelFactoryService(host).open(context);
        const graph = model.modules[0];
        assert.equal([...nodeDescriptions(graph)][0]._scope, 'explicit/first');
        assert.equal(nodeCatalog(graph.nodes).cache.size, 0);
        const analysis = await graphGroups(graph);
        assert.ok(analysis.groups.has('/explicit/first'));
        assert.equal(graph.nodes[0]._scope, 'explicit/first');
    } finally {
        context.source.dispose();
        await fs.rm(folder, { recursive: true, force: true });
    }
});

test('cancelled grouping never publishes a partial hierarchy', async () => {
    const graph = hierarchyFixture();
    let checks = 0;
    assert.equal(await graphGroups(graph, () => ++checks < 5), null);
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    view.options.foldRepeatedBlocks = true;
    assert.equal(await view._groupedPresentation(graph, () => false), graph);
    assert.ok(!view._groupStates.has(graph));
});

test('anonymous execution graphs reuse structural detection without reading weights', async () => {
    const type = { dataType: 'float32', shape: { dimensions: [null, 8] } };
    const arg = (name, dimensions = [null, 8]) => ({ name, value: [{ name, type: { ...type, shape: { dimensions } } }] });
    const graph = { nodes: [], inputs: [arg('input')], outputs: [] };
    const parameterType = { dataType: 'float32', shape: { dimensions: [8, 16] } };
    const weight = { name: 'weight', type: parameterType, initializer: { type: parameterType, get values() {
        throw new Error('Grouping cannot read parameters.');
    } } };
    let previous = graph.inputs[0];
    for (let i = 0; i < 12; i++) {
        const output = arg(`tensor${i}`, [null, i % 4 < 2 ? 16 : 8]);
        const matrix = i % 2 === 0;
        graph.nodes.push({ name: `op${i}`, type: { name: ['MatMul', 'Relu', 'MatMul', 'Sigmoid'][i % 4], domain: '', version: 20 }, attributes: [],
            inputs: matrix ? [previous, { name: 'weight', value: [weight] }] : [previous], outputs: [output] });
        previous = output;
    }
    graph.outputs = [previous];
    const analysis = await graphGroups(graph);
    assert.ok(analysis.groups.size > 1, 'Retain distinct instances of a detected repeated pattern.');
    assert.deepEqual([...nodeDescriptions(analysis.project(new Set(analysis.groups.keys())))].map((node) => node._originalNode), graph.nodes);
    assert.equal(analysis.project().outputs, graph.outputs);
});
