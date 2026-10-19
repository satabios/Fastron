// Run: node test/architecture-folder.mjs graph-examples
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ModelFactoryService, View } from '../source/view.js';
import { NodeCatalog, nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { openSource } from '../source/model-source.mjs';
import { patternBlocks } from '../source/pattern-blocks.js';

if (!process.argv[2]) {
    throw new Error('Usage: node test/architecture-folder.mjs /path/to/models');
}
const folder = path.resolve(process.argv[2]);
const files = (await fs.readdir(folder)).filter((name) => /\.(onnx|json)$/i.test(name)).sort();
assert.ok(files.length, 'The folder must contain ONNX or JSON models.');
// Expectations for supplied fixtures only; recognition never consults filenames.
const expectedBlocks = new Map([
    ['qwen3_vl_p2b_instruct_vision_slim.onnx', 24],
    ['qwen3_vl_p2b_instruct_d28_1111111011011100010_slim.onnx', 28]
]);
for (const file of files) {
    const host = new Host({ serial: true });
    // eslint-disable-next-line no-await-in-loop
    const context = await openSource(host, { path: path.join(folder, file) });
    try {
        // eslint-disable-next-line no-await-in-loop
        const model = await new ModelFactoryService(host).open(context);
        const graph = model.modules[0];
        // eslint-disable-next-line no-await-in-loop
        const before = await context.source.request('stats');
        // eslint-disable-next-line no-await-in-loop
        const generic = await patternBlocks(graph);
        const view = new View(host);
        view.model = model;
        view.options.foldRepeatedBlocks = true;
        const started = performance.now();
        // eslint-disable-next-line no-await-in-loop
        const display = await view._repeatedPresentation(graph, () => true);
        const analysisMs = performance.now() - started;
        const analysis = view._repeatStates.get(graph)?.analysis;
        const original = [...nodeDescriptions(graph)];
        const softmax = original.filter((node) => node.type.name === 'Softmax').length;
        const blocks = analysis?.groups.filter((group) => group.architecture).flatMap((group) => group.blocks) || [];
        if (expectedBlocks.has(file)) {
            assert.equal(blocks.length, expectedBlocks.get(file), `Unexpected Transformer count in ${file}`);
            assert.equal(analysis.architecture.matchedSoftmax, softmax, `Unaccounted Softmax operators in ${file}`);
        }
        const expanded = analysis?.project(new Map(), new Set(analysis.groups.map((group) => group.id))) || graph;
        assert.deepEqual([...nodeDescriptions(expanded)].map((node) => node._originalNode || node), original);
        const projected = [...nodeDescriptions(display)];
        const outputs = new Set([...display.inputs, ...projected.flatMap((node) => node.outputs)]
            .flatMap((arg) => arg.value.map((value) => value.name)));
        for (const value of [...display.outputs, ...projected.flatMap((node) => node.inputs)].flatMap((arg) => arg.value)) {
            assert.ok(!value.name || value.initializer || outputs.has(value.name), `Orphan tensor ${value.name}`);
        }
        const names = new Map();
        const rename = (value) => {
            if (!value.name) {
                return value;
            }
            if (!names.has(value.name)) {
                names.set(value.name, `tensor${names.size}`);
            }
            return { ...value, name: names.get(value.name) };
        };
        const args = (items) => items.map((arg) => ({ ...arg, value: arg.value.map(rename) }));
        const records = original.map((node, i) => ({ ...node, name: `node${i}`, inputs: args(node.inputs), outputs: args(node.outputs) }));
        const renamed = { nodes: new NodeCatalog(records, () => {
            throw new Error('Renamed graph analysis must not construct rich nodes.');
        }, (node) => node).nodes, inputs: args(graph.inputs), outputs: args(graph.outputs) };
        const other = new View(host);
        other.model = { modules: [renamed] };
        other.options.foldRepeatedBlocks = true;
        // eslint-disable-next-line no-await-in-loop
        const renamedDisplay = await other._repeatedPresentation(renamed, () => true);
        const matches = (items) => (items || []).map((group) => ({ architecture: group.architecture, members: [...group.members] }));
        assert.deepEqual(matches(other._repeatStates.get(renamed)?.analysis.groups), matches(analysis?.groups));
        assert.equal(renamedDisplay.nodes.length, display.nodes.length);
        // eslint-disable-next-line no-await-in-loop
        const after = await context.source.request('stats');
        assert.equal(after.readBytes, before.readBytes, 'Analysis cannot fetch parameter data.');
        assert.equal(nodeCatalog(graph.nodes)?.cache.size || 0, 0, 'Analysis cannot construct rich nodes.');
        process.stdout.write(`${JSON.stringify({ file, operators: graph.nodes.length, softmax,
            transformerBlocks: blocks.length, softmaxInBlocks: analysis?.architecture?.matchedSoftmax || 0,
            softmaxPerBlock: [...new Set(blocks.map((block) => block.softmaxCount))],
            profiles: [...new Set(blocks.map((block) => `${block.profile.normalization} · ${block.profile.label}`))],
            genericRepeatCounts: generic?.groups.filter((group) => group.blocks.length > 1).map((group) => group.blocks.length) || [],
            transformerRuns: analysis?.groups.filter((group) => group.architecture).map((group) => group.blocks.length) || [],
            displayed: display.nodes.length, analysisMs: Math.round(analysisMs), renamedGraphMatches: true,
            canonicalExpansionMatches: true, additionalSourceBytes: 0, materializedNodes: 0 })}\n`);
    } finally {
        context.source.dispose();
    }
}
