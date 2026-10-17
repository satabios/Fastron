// Run: node test/efficientvit-folding.mjs /path/to/efficientvit_b3.onnx
import * as assert from 'node:assert/strict';
import { nodeCatalog, nodeDescriptions, repeatedBlocks } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { ModelFactoryService } from '../source/view.js';
import { openSource } from '../source/model-source.mjs';

if (!process.argv[2]) {
    throw new Error('Usage: node test/efficientvit-folding.mjs /path/to/efficientvit_b3.onnx');
}
const host = new Host({ serial: true });
const context = await openSource(host, { path: process.argv[2] });
try {
    const graph = (await new ModelFactoryService(host).open(context)).modules[0];
    const before = await context.source.request('stats');
    const analysis = await repeatedBlocks(graph);
    assert.ok(analysis);
    assert.equal(graph.nodes.length, 682);
    assert.deepEqual(analysis.groups.map((group) => [group.prefix, Array.from(group.blocks, (block) => block.index)]), [
        ['/stages/stages.0/blocks/blocks.', [1, 2, 3]],
        ['/stages/stages.1/blocks/blocks.', [1, 2, 3, 4, 5]],
        ['/stages/stages.2/blocks/blocks.', [2, 3, 4, 5, 6]],
        ['/stages/stages.3/blocks/blocks.', [2, 3, 4, 5, 6, 7, 8, 9]]
    ]);
    const folded = analysis.project();
    assert.equal(folded.nodes.length, 206);
    const checkConnections = (display) => {
        const nodes = Array.from(nodeDescriptions(display));
        const names = new Set([...display.inputs, ...nodes.flatMap((node) => node.outputs)]
            .flatMap((arg) => arg.value.map((value) => value.name)));
        for (const node of nodes) {
            for (const value of node.inputs.flatMap((arg) => arg.value)) {
                assert.ok(value.initializer || names.has(value.name), `Orphan input: ${value.name}`);
            }
        }
        for (const value of display.outputs.flatMap((arg) => arg.value)) {
            assert.ok(names.has(value.name), `Missing graph output: ${value.name}`);
        }
    };
    checkConnections(folded);
    for (const group of analysis.groups) {
        const index = group.blocks.length - 1;
        const selected = analysis.project(new Map([[group.id, index]]));
        const name = Array.from(nodeDescriptions(selected)).find((node) => node._repeatGroup === group && node._repeatHeader).name;
        assert.ok(name.startsWith(`${group.prefix}${group.blocks[index].index}/`));
        assert.deepEqual(analysis.locate({ name }), { group, index });
        checkConnections(selected);
        assert.equal(analysis.project(new Map(), new Set([group.id])).nodes.length,
            folded.nodes.length + group.members.length - group.blocks[0].indices.length);
    }
    const expanded = analysis.project(new Map(), new Set(analysis.groups.map((group) => group.id)));
    assert.deepEqual(Array.from(nodeDescriptions(expanded), (node) => node.name), Array.from(nodeDescriptions(graph), (node) => node.name));
    checkConnections(expanded);
    assert.equal(nodeCatalog(graph.nodes).cache.size, 0, 'Folding descriptors cannot materialize canonical rich nodes.');
    assert.equal((await context.source.request('stats')).readBytes, before.readBytes, 'Folding and selection cannot fetch weights.');
    process.stdout.write(`${JSON.stringify({ nodes: graph.nodes.length, foldedNodes: folded.nodes.length,
        stacks: analysis.groups.map((group) => group.label), additionalSourceBytes: 0 })}\n`);
} finally {
    context.source.dispose();
}
