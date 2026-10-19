// Run: node test/resnet-folding.mjs /path/to/resnet50.onnx
import * as assert from 'node:assert/strict';
import { ModelFactoryService, View } from '../source/view.js';
import { nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { openSource } from '../source/model-source.mjs';
import { patternBlocks } from '../source/pattern-blocks.js';

if (!process.argv[2]) {
    throw new Error('Usage: node test/resnet-folding.mjs /path/to/resnet50.onnx');
}
const host = new Host({ serial: true });
const context = await openSource(host, { path: process.argv[2] });
try {
    const model = await new ModelFactoryService(host).open(context);
    const graph = model.modules[0];
    const view = new View(host);
    view.model = model;
    assert.equal(await view._repeatedPresentation(graph, () => true), graph);
    const before = await context.source.request('stats');
    view.options.foldRepeatedBlocks = true;
    const started = performance.now();
    const display = await view._repeatedPresentation(graph, () => true);
    const analysisMs = performance.now() - started;
    const analysis = view._repeatStates.get(graph).analysis;
    assert.equal(graph.nodes.length, 122);
    assert.equal(display.nodes.length, 14);
    assert.deepEqual(analysis.groups.map((g) => g.blocks.length), [1, 2, 1, 3, 1, 5, 1, 2]);
    assert.ok(analysis.groups.every((g) => g.kind === 'pattern'));
    const checkConnections = (projection) => {
        const nodes = [...nodeDescriptions(projection)];
        const names = new Set([...projection.inputs, ...nodes.flatMap((node) => node.outputs)]
            .flatMap((arg) => arg.value.map((value) => value.name)));
        for (const value of [...projection.outputs, ...nodes.flatMap((node) => node.inputs)].flatMap((arg) => arg.value)) {
            assert.ok(value.initializer || names.has(value.name), `Orphan tensor ${value.name}`);
        }
    };
    checkConnections(display);
    for (const group of analysis.groups) {
        assert.ok(group.blocks.every((b) => b.indices.length === (group.blocks.length === 1 ? 8 : 7)));
        const last = group.blocks.length - 1;
        const selected = analysis.project(new Map([[group.id, last]]));
        checkConnections(selected);
        const summary = [...nodeDescriptions(selected)].find((node) => node._repeatGroup === group);
        checkConnections(summary.type);
        assert.deepEqual([...nodeDescriptions(summary.type)].map((node) => node.name),
            [...group.blocks[last].indices].map((index) => analysis.describe(index).name));
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await patternBlocks(summary.type), null);
        checkConnections(analysis.project(new Map(), new Set([group.id])));
    }
    const expanded = analysis.project(new Map(), new Set(analysis.groups.map((group) => group.id)));
    assert.deepEqual([...nodeDescriptions(expanded)].map((n) => n.name), [...nodeDescriptions(graph)].map((n) => n.name));
    checkConnections(expanded);
    const names = new Map();
    const rename = (value) => {
        if (!names.has(value.name)) {
            names.set(value.name, `tensor${names.size}`);
        }
        return { ...value, name: names.get(value.name) };
    };
    const args = (items) => items.map((arg) => ({ ...arg, value: arg.value.map(rename) }));
    const renamed = { nodes: [...nodeDescriptions(graph)].map((node, i) => ({ ...node, name: `node${i}`,
        inputs: args(node.inputs), outputs: args(node.outputs) })), inputs: args(graph.inputs), outputs: args(graph.outputs) };
    const other = await patternBlocks(renamed);
    assert.deepEqual(other.groups.map((g) => [...g.members]), analysis.groups.map((g) => [...g.members]));
    assert.equal(nodeCatalog(graph.nodes).cache.size, 0);
    assert.equal((await context.source.request('stats')).readBytes, before.readBytes);
    process.stdout.write(`${JSON.stringify({ nodes: graph.nodes.length, displayed: display.nodes.length, analysisMs,
        bottlenecks: 16, projectionBlocks: 4, stacks: [2, 3, 5, 2], renamedGraphMatches: true, additionalSourceBytes: 0 })}\n`);
} finally {
    context.source.dispose();
}
