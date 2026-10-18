// Run: node test/qwen-vision-folding.mjs /path/to/qwen3_vl_p2b_instruct_vision_slim.onnx
import * as assert from 'node:assert/strict';
import { nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { ModelFactoryService } from '../source/view.js';
import { openSource } from '../source/model-source.mjs';
import { structuralBlocks } from '../source/structural-blocks.js';

if (!process.argv[2]) {
    throw new Error('Usage: node test/qwen-vision-folding.mjs /path/to/qwen3_vl_p2b_instruct_vision_slim.onnx');
}
const host = new Host({ serial: true });
const context = await openSource(host, { path: process.argv[2] });
try {
    const graph = (await new ModelFactoryService(host).open(context)).modules[0];
    const before = await context.source.request('stats');
    const started = performance.now();
    const analysis = await structuralBlocks(graph);
    const analysisMs = performance.now() - started;
    assert.equal(graph.nodes.length, 1170);
    assert.deepEqual(analysis?.groups.map((group) => group.blocks.map((block) => block.index)), [
        [0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17], [18, 19, 20, 21, 22, 23]
    ]);
    const folded = analysis.project();
    assert.equal(folded.nodes.length, 70);
    const checkConnections = (display) => {
        const nodes = Array.from(nodeDescriptions(display));
        const names = new Set([...display.inputs, ...nodes.flatMap((node) => node.outputs)]
            .flatMap((arg) => arg.value.map((value) => value.name)));
        for (const value of [...nodes.flatMap((node) => node.inputs), ...display.outputs].flatMap((arg) => arg.value)) {
            assert.ok(value.initializer || names.has(value.name), `Orphan tensor: ${value.name}`);
        }
    };
    checkConnections(folded);
    for (const group of analysis.groups) {
        const selected = analysis.project(new Map([[group.id, group.blocks.length - 1]]));
        checkConnections(selected);
        const summary = Array.from(nodeDescriptions(selected)).find((node) => node._repeatGroup === group && node._repeatHeader);
        // eslint-disable-next-line no-await-in-loop
        const children = await structuralBlocks(summary.type);
        const display = children.project();
        const parts = Array.from(nodeDescriptions(display));
        assert.deepEqual(parts.map((node) => node.type.name), ['LayerNormalization', 'Attention', 'Add', 'LayerNormalization', 'MLP', 'Add']);
        assert.equal(parts[1].type.nodes.length, 37);
        assert.equal(parts[4].type.nodes.length, 5);
        // The printed packed 1024→3072 QKV projection is exported as three 1024→1024 Conv projections.
        const weights = (part) => Array.from(nodeDescriptions(part.type)).filter((node) => node.type.name === 'Conv')
            .map((node) => node.inputs.flatMap((arg) => arg.value)[1].type.shape.dimensions);
        assert.deepEqual(weights(parts[1]), Array(4).fill([1024, 1024, 1, 1]));
        assert.deepEqual(weights(parts[4]), [[4096, 1024, 1, 1], [1024, 4096, 1, 1]]);
        checkConnections(display);
    }
    const expanded = analysis.project(new Map(), new Set(analysis.groups.map((group) => group.id)));
    assert.deepEqual(Array.from(nodeDescriptions(expanded), (node) => node.name), Array.from(nodeDescriptions(graph), (node) => node.name));
    checkConnections(expanded);
    const names = new Map();
    const rename = (value) => {
        if (!names.has(value.name)) {
            names.set(value.name, `v${names.size}`);
        }
        return { ...value, name: names.get(value.name) };
    };
    const args = (items) => items.map((arg) => ({ ...arg, value: arg.value.map(rename) }));
    const renamed = { nodes: Array.from(nodeDescriptions(graph), (node, i) => ({ ...node, name: `n${i}`,
        inputs: args(node.inputs), outputs: args(node.outputs) })), inputs: args(graph.inputs), outputs: args(graph.outputs) };
    const other = await structuralBlocks(renamed);
    assert.deepEqual(other?.groups.map((group) => Array.from(group.members)), analysis.groups.map((group) => Array.from(group.members)));
    assert.equal(nodeCatalog(graph.nodes).cache.size, 0);
    assert.equal((await context.source.request('stats')).readBytes, before.readBytes);
    process.stdout.write(`${JSON.stringify({ nodes: graph.nodes.length, foldedNodes: folded.nodes.length, analysisMs,
        stacks: analysis.groups.map((group) => group.blocks.length), renamedGraphMatches: true, additionalSourceBytes: 0 })}\n`);
} finally {
    context.source.dispose();
}
