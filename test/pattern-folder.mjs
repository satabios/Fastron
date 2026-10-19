// Run: node test/pattern-folder.mjs /path/to/models
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ModelFactoryService, View } from '../source/view.js';
import { NodeCatalog, nodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { openSource } from '../source/model-source.mjs';

if (!process.argv[2]) {
    throw new Error('Usage: node test/pattern-folder.mjs /path/to/models');
}
const folder = path.resolve(process.argv[2]);
const files = (await fs.readdir(folder)).filter((name) => /\.(onnx|json)$/i.test(name)).sort();
assert.ok(files.length, 'The folder must contain ONNX or JSON models.');
for (const file of files) {
    const host = new Host({ serial: true });
    // eslint-disable-next-line no-await-in-loop
    const context = await openSource(host, { path: path.join(folder, file) });
    try {
        // eslint-disable-next-line no-await-in-loop
        const model = await new ModelFactoryService(host).open(context);
        const graph = model.modules[0];
        const view = new View(host);
        view.model = model;
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await view._repeatedPresentation(graph, () => true), graph);
        // eslint-disable-next-line no-await-in-loop
        const before = await context.source.request('stats');
        view.options.foldRepeatedBlocks = true;
        const started = performance.now();
        // Exercise the same generic finder and cache as the toolbar in every host.
        // eslint-disable-next-line no-await-in-loop
        const display = await view._repeatedPresentation(graph, () => true);
        const analysisMs = performance.now() - started;
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await context.source.request('stats')).readBytes, before.readBytes);
        assert.equal(nodeCatalog(graph.nodes)?.cache.size || 0, 0);
        const groups = view._repeatStates.get(graph)?.analysis.groups || [];
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
        const original = [...nodeDescriptions(graph)];
        const records = original.map((node, i) => ({ ...node, name: `node${i}`,
            inputs: args(node.inputs), outputs: args(node.outputs) }));
        const renamed = { nodes: new NodeCatalog(records, () => {
            throw new Error('Renamed graph recognition must use descriptors.');
        }, (node) => node).nodes, inputs: args(graph.inputs), outputs: args(graph.outputs) };
        const other = new View(host);
        other.model = { modules: [renamed] };
        other.options.foldRepeatedBlocks = true;
        // eslint-disable-next-line no-await-in-loop
        const renamedDisplay = await other._repeatedPresentation(renamed, () => true);
        const matches = (items) => items.map((g) => g.blocks.map((b) => [...b.indices]));
        assert.deepEqual(matches(other._repeatStates.get(renamed)?.analysis.groups || []), matches(groups));
        assert.equal(renamedDisplay.nodes.length, display.nodes.length);
        const analysis = view._repeatStates.get(graph)?.analysis;
        if (analysis) {
            const expanded = analysis.project(new Map(), new Set(groups.map((g) => g.id)));
            assert.deepEqual([...nodeDescriptions(expanded)].map((n) => n.name), original.map((n) => n.name));
            const outputs = new Set([...display.inputs, ...[...nodeDescriptions(display)].flatMap((n) => n.outputs)]
                .flatMap((arg) => arg.value.map((v) => v.name)));
            for (const value of [...display.outputs, ...[...nodeDescriptions(display)].flatMap((n) => n.inputs)].flatMap((arg) => arg.value)) {
                assert.ok(!value.name || value.initializer || outputs.has(value.name), `Orphan tensor ${value.name}`);
            }
        }
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await context.source.request('stats')).readBytes, before.readBytes);
        process.stdout.write(`${JSON.stringify({ file, nodes: graph.nodes.length, displayed: display.nodes.length,
            analysisMs: Math.round(analysisMs), groups: groups.length, stacks: groups.filter((group) => group.blocks.length > 1).map((group) => group.blocks.length),
            renamedGraphMatches: true, additionalSourceBytes: 0, materializedNodes: 0 })}\n`);
    } finally {
        context.source.dispose();
    }
}
