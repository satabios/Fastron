import * as assert from 'node:assert/strict';
import { Graph, View } from '../source/view.js';
import { NodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { indexRange, stackPresentation } from '../source/stack-presentation.js';
import { renderStackSchematic, stackSchematic } from '../source/stack-schematic.js';
import { Host } from './mock.js';
import { patternBlocks } from '../source/pattern-blocks.js';
import { test } from 'node:test';

const fixture = (renamed = false, gap = false) => {
    const type = { dataType: 'float32', shape: { dimensions: [8] } };
    const arg = (name) => ({ name, value: [{ name, type }] });
    const graph = { nodes: [], inputs: [arg('input')], outputs: [] };
    let previous = graph.inputs[0];
    let layer = 0;
    const add = (op, name) => {
        const output = arg(`v${graph.nodes.length}`);
        graph.nodes.push({ name: renamed ? `node${graph.nodes.length}` : name, type: { name: op }, attributes: [],
            inputs: [previous, { name: 'weight', value: [{ name: `w${graph.nodes.length}`, type,
                initializer: { type, get values() {
                    throw new Error('Weights must remain unread.');
                } } }] }], outputs: [output] });
        previous = output;
    };
    for (let stage = 0; stage < 4; stage++) {
        for (let i = 0; i < 6; i++, layer++) {
            const index = gap && layer >= 12 ? layer + 1 : layer;
            add('UnfamiliarA', `/encoder/units.${index}/A`);
            add('UnfamiliarB', `/encoder/units.${index}/B`);
        }
        if (stage < 3) {
            add('UnfamiliarTail', `/encoder/tail.${stage}/C`);
        }
    }
    graph.outputs = [previous];
    graph.nodes = new NodeCatalog(graph.nodes, () => {
        throw new Error('Preview must use descriptors.');
    }, (node) => node).nodes;
    return graph;
};

test('block schematics infer anatomy from connectivity without reading weights', () => {
    const type = { dataType: 'float16', shape: { dimensions: [1, 8, 896] } };
    const arg = (name) => ({ name, value: [{ name, type }] });
    const weight = { name: 'w', type, initializer: { get values() {
        throw new Error('Weight read');
    } } };
    const nodes = [];
    const add = (op, inputs, output) => nodes.push({ type: { name: op }, inputs: inputs.map(arg).concat([{ name: 'weight', value: [weight] }]), outputs: [arg(output)] });
    add('RmsNorm', ['input'], 'norm');
    add('Softmax', ['norm'], 'attention');
    add('Add', ['input', 'attention'], 'residual');
    add('RmsNorm', ['residual'], 'norm2');
    add('MatMul', ['norm2'], 'up');
    add('Silu', ['up'], 'activation');
    add('MatMul', ['activation'], 'down');
    add('Add', ['residual', 'down'], 'output');
    const analysis = { describe: (index) => nodes[index] };
    const group = { blocks: [{ index: 7, indices: Uint32Array.from(nodes, (_, i) => i) }, { index: 8 }] };
    const schematic = stackSchematic(analysis, group);
    assert.deepEqual(schematic.regions[0].zones.map((zone) => [zone.kind, zone.residual]), [['attention', true], ['mlp', true]]);
    assert.equal(schematic.precision, 'float16');
    assert.deepEqual(schematic.outputShapes, ['[1, 8, 896]']);
    const host = new Host({ serial: true });
    const svg = renderStackSchematic(host.document, schematic, () => {});
    assert.equal(svg.getAttribute('role'), 'group');
    // An ordinary Add of two branches is not a bypass from the zone input.
    nodes[2].inputs = [arg('norm'), arg('attention')];
    assert.equal(stackSchematic(analysis, group).regions[0].zones[0].residual, false);
    nodes[2].inputs = [arg('attention'), arg('attention')];
    const ordinary = stackSchematic(analysis, group);
    assert.equal(ordinary.regions[0].zones.length, 1);
    assert.equal(ordinary.regions[0].zones[0].residual, false);
    nodes[2].inputs = [arg('input'), arg('attention')];
    nodes[1].inputs = [arg('unrelated')];
    assert.equal(stackSchematic(analysis, group).regions[0].zones[0].residual, false,
        'A bypass must reach the branch, not merely occur in another input.');
});

test('nested recipes expose multiplication, source ranges and real connections using metadata only', async () => {
    const graph = fixture();
    const analysis = await patternBlocks(graph);
    const canonical = [...nodeDescriptions(graph)];
    const before = analysis.groups.map((g) => [...g.members]);
    await stackPresentation(analysis);
    const [outer, leaf] = analysis.groups;
    assert.deepEqual(analysis.groups.map((g) => g.blocks.length), [3, 6]);
    assert.deepEqual(outer.presentation.parts.map((p) => [p.count, p.operators, p.linked]), [[6, 2, true], [1, 1, false]]);
    assert.equal(outer.presentation.total, '24 units (3 × 6 + 6)');
    assert.deepEqual(outer.presentation.ranges.map(indexRange), ['0–5', '6–11', '12–17']);
    assert.equal(indexRange(leaf.presentation.indices), '18–23');
    assert.equal(leaf.presentation.compound, false);
    const schematic = stackSchematic(analysis, outer, 2);
    assert.equal(schematic.layerMix, '24 units (3 × 6 + 6)');
    assert.deepEqual(schematic.regions.map((region) => [region.count, region.operators]), [[6, 2], [1, 1]]);
    assert.deepEqual([...schematic.regions[0].indices], [...outer.blocks[2].indices.slice(0, 2)]);
    assert.ok(schematic.regions.every((region) => region.zones.every((zone) => zone.kind === 'operations' && !zone.residual)));
    assert.deepEqual(analysis.groups.map((g) => [...g.members]), before);
    assert.deepEqual([...nodeDescriptions(analysis.project(new Map(), new Set(analysis.groups.map((g) => g.id))))].map((n) => n._originalNode || n), canonical);
    const other = await patternBlocks(fixture(true));
    await stackPresentation(other);
    assert.deepEqual(other.groups.map((g) => [...g.members]), before, 'Recognition must ignore source names.');
    assert.deepEqual(other.groups[0].presentation.parts, outer.presentation.parts);
    assert.equal(other.groups[0].presentation.family, undefined);
    assert.equal(other.groups[0].presentation.total, undefined, 'Renamed graphs cannot claim source layer counts.');
});

test('gapped provenance stays explicit and cancellation publishes no partial previews', async () => {
    const analysis = await patternBlocks(fixture(false, true));
    await stackPresentation(analysis);
    assert.equal(analysis.groups[0].presentation.total, '24 units (3 × 6 + 6)');
    assert.equal(indexRange(analysis.groups[0].presentation.indices), '0, 1, 2, 3, 4, 5, …');
    const cancelled = await patternBlocks(fixture());
    let checks = 0;
    await stackPresentation(cancelled, () => ++checks < 4);
    assert.ok(cancelled.groups.every((g) => !g.presentation));
});

test('compound cards reuse nested node rendering and inspect the selected real instance', async () => {
    const graph = fixture();
    const analysis = await patternBlocks(graph);
    await stackPresentation(analysis);
    const host = new Host({ serial: true });
    const view = new View(host);
    view.model = { modules: [graph] };
    view._path = [{ target: graph }];
    const state = { analysis, selected: new Map([[0, 2]]), expanded: new Set() };
    view._repeatStates.set(graph, state);
    const ui = new Graph(view, false);
    ui.add(analysis.project(state.selected));
    ui.build(host.document);
    await ui.measure();
    const card = [...ui.nodes.values()].map((entry) => entry.label).find((node) => node._compound);
    assert.ok(card.class.includes('node-compound'));
    let clicked = null;
    const showRepeatedBlock = view.showRepeatedBlock;
    view.showRepeatedBlock = (group) => {
        clicked = group;
    };
    card._blocks[0]._entries[0].emit('click');
    assert.equal(clicked, analysis.groups[0], 'Clicking a stack title opens its anatomy.');
    view.showRepeatedBlock = showRepeatedBlock;
    let sidebar = null;
    view._sidebar.open = (content) => {
        sidebar = content;
    };
    view.showRepeatedBlock(analysis.groups[0]);
    assert.equal(sidebar.element.getElementsByClassName('stack-schematic').length, 1);
    assert.equal(card._stackDepth, 0, 'Outer stages use frames, not leaf decks.');
    const children = card._blocks.flatMap((block) => block._items || []).map((item) => item.content).filter((item) => item?._blocks);
    assert.equal(children.length, 2);
    assert.equal(children[0]._stackDepth, 2);
    let opened = null;
    view.pushTarget = async (target) => {
        opened = target;
    };
    children[0]._blocks[0]._entries[1].emit('click');
    assert.deepEqual([...nodeDescriptions(opened)].map((n) => n.name), ['/encoder/units.12/A', '/encoder/units.12/B']);
    card.x = 0;
    card.y = 0;
    card.layout();
    card.update();
    const size = [card.width, card.height];
    assert.ok(size.every(Number.isFinite));
    card.release();
    card.buildOverview(host.document, host.document.body);
    card.updateOverview();
    assert.deepEqual([card.width, card.height], size);
    assert.equal(card._overviewText.textContent, '3 × 6 units');
    card.release();
});
