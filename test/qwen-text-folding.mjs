// Run: node test/qwen-text-folding.mjs /path/to/qwen3_vl_p2b_instruct_d28_1111111011011100010_slim.onnx
import * as assert from 'node:assert/strict';
import { nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { ModelFactoryService } from '../source/view.js';
import { openSource } from '../source/model-source.mjs';
import { structuralBlocks } from '../source/structural-blocks.js';

if (!process.argv[2]) {
    throw new Error('Usage: node test/qwen-text-folding.mjs /path/to/qwen3_vl_p2b_instruct_d28_1111111011011100010_slim.onnx');
}
const host = new Host({ serial: true });
const context = await openSource(host, { path: process.argv[2] });
try {
    const graph = (await new ModelFactoryService(host).open(context)).modules[0];
    const before = await context.source.request('stats');
    const started = performance.now();
    const analysis = await structuralBlocks(graph);
    const analysisMs = performance.now() - started;
    assert.equal(graph.nodes.length, 19449);
    assert.deepEqual(analysis?.groups.map((group) => group.blocks.map((block) => block.index)), [
        [0], [1], [2], Array.from({ length: 25 }, (_, i) => i + 3)
    ]);
    assert.ok(analysis.groups.every((group) => group.kind === 'pattern'));
    const folded = analysis.project();
    assert.equal(folded.nodes.length, 608);
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
        const summary = Array.from(nodeDescriptions(selected)).find((node) => node._repeatGroup === group);
        // eslint-disable-next-line no-await-in-loop
        const children = await structuralBlocks(summary.type);
        const display = children.project();
        const parts = Array.from(nodeDescriptions(display));
        assert.deepEqual(parts.map((node) => node.type.name), ['Normalization', 'Attention (GQA)', 'Add', 'Normalization', 'MLP', 'Add']);
        assert.equal(parts[1].type.nodes.length, group.id === 0 ? 647 : 646);
        assert.equal(parts[4].type.nodes.length, 11);
        // Architecture reference: user-provided Qwen3-VL-2B-Instruct print, 2026-10-18.
        const attentionNodes = Array.from(nodeDescriptions(parts[1].type));
        const mlpNodes = Array.from(nodeDescriptions(parts[4].type));
        const linearShapes = (nodes) => nodes.filter((node) => node.type.name === 'Conv').map((node) => {
            const weight = node.inputs.flatMap((arg) => arg.value)[1].type.shape.dimensions;
            assert.deepEqual(weight.slice(2), [1, 1], 'The export lowers Linear modules to pointwise Conv.');
            return [weight[1], weight[0]];
        });
        assert.deepEqual(linearShapes(attentionNodes), [[2048, 2048], [2048, 1024], [2048, 1024], [2048, 2048]]);
        assert.deepEqual(linearShapes(mlpNodes), [[2048, 6144], [2048, 6144], [6144, 2048]]);
        assert.equal(mlpNodes.filter((node) => node.type.name === 'Sigmoid').length, 1);
        assert.equal(mlpNodes.filter((node) => node.type.name === 'Mul').length, 2);
        const normUses = attentionNodes.flatMap((node) => node.inputs.flatMap((arg) => arg.value))
            .filter((value) => value.initializer && value.type?.shape?.dimensions?.length === 1 && value.type.shape.dimensions[0] === 128);
        const aliases = new Map();
        for (const value of normUses) {
            aliases.set(value.name, (aliases.get(value.name) || 0) + 1);
        }
        assert.deepEqual(Array.from(aliases.values()).sort((a, b) => a - b), [8, 16], 'One K norm and one Q norm are reused across heads.');
        assert.deepEqual(parts[1].attributes.filter((attr) => attr.name !== 'operators').map((attr) => attr.value), [16, 8]);
        checkConnections(display);
        // eslint-disable-next-line no-await-in-loop
        const attention = await structuralBlocks(parts[1].type);
        const foldedAttention = attention.project();
        assert.equal(foldedAttention.nodes.length, group.id === 0 ? 16 : 15);
        assert.deepEqual(attention.groups.map((item) => item.blocks.length), group.id === 0 ? [1, 7] : [8]);
        assert.deepEqual(attention.groups.flatMap((item) => item.blocks.map((block) => block.index)), [0, 1, 2, 3, 4, 5, 6, 7]);
        checkConnections(foldedAttention);
        const stack = attention.groups.at(-1);
        const chosen = attention.project(new Map([[stack.id, stack.blocks.length - 1]]));
        const kv = Array.from(nodeDescriptions(chosen)).find((node) => node._repeatHeader);
        const operators = Array.from(nodeDescriptions(kv.type));
        assert.equal(operators.length, 79);
        assert.equal(operators.filter((node) => node.type.name === 'Softmax').length, 2);
        assert.equal(operators.filter((node) => node.type.name === 'ScatterElements').length, 2);
        checkConnections(chosen);
        checkConnections(kv.type);
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
