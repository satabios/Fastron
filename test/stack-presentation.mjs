import * as assert from 'node:assert/strict';
import { Graph, View } from '../source/view.js';
import { NodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { indexRange, stackPresentation } from '../source/stack-presentation.js';
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
