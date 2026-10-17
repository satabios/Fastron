// Run: node test/benchmark-model-opening.mjs /path/to/model.onnx [--fold]
import * as assert from 'node:assert/strict';
import { Graph, ModelFactoryService, View } from '../source/view.js';
import { Host } from './mock.js';
import { openSource } from '../source/model-source.mjs';

if (!process.argv[2]) {
    throw new Error('Usage: node test/benchmark-model-opening.mjs /path/to/model.onnx');
}
const host = new Host({ serial: true });
const started = performance.now();
const context = await openSource(host, { path: process.argv[2] });
const indexed = performance.now();
try {
    const model = await new ModelFactoryService(host).open(context);
    const parsed = performance.now();
    const view = new View(host);
    view.model = model;
    const graph = new Graph(view, model.modules[0].groups || false);
    graph.enableViewportCulling(true, 300);
    graph.configureDeferredRendering({ detachInvisible: true, estimatedNodeSizeThreshold: 500 });
    const before = await context.source.request('stats');
    if (process.argv.includes('--fold')) {
        view.options.foldRepeatedBlocks = true;
    }
    const display = await view._repeatedPresentation(model.modules[0], () => true);
    graph.add(display);
    graph.build(host.document);
    await graph.measure();
    const prepared = performance.now();
    const connections = Array.from(graph.edges.values(), ({ v, w }) => [v, w]);
    const nodeCount = graph.nodes.size;
    assert.equal(await graph.layout(null), '');
    const laidOut = performance.now();
    assert.equal(graph.nodes.size, nodeCount);
    assert.deepEqual(Array.from(graph.edges.values(), ({ v, w }) => [v, w]), connections);
    let routePoints = 0;
    for (const { label } of graph.edges.values()) {
        assert.ok(label.points.length >= 2);
        assert.ok(label.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
        routePoints += label.points.length;
    }
    const tileStarted = performance.now();
    graph.populateTiles();
    graph.compactLayout();
    const tileIndexMs = performance.now() - tileStarted;
    const after = await context.source.request('stats');
    assert.equal(after.readBytes, before.readBytes, 'Layout and tile indexing must not read weights.');
    assert.equal(view.options.foldRepeatedBlocks, process.argv.includes('--fold'));
    process.stdout.write(`${JSON.stringify({ file: process.argv[2], modelNodes: model.modules[0].nodes.length,
        displayNodes: display.nodes.length, layoutNodes: nodeCount, connections: connections.length, routePoints,
        indexMs: indexed - started, parseMs: parsed - indexed, prepareMs: prepared - parsed,
        layoutMs: laidOut - prepared, tileIndexMs,
        sourceBytesDuringRendering: after.readBytes - before.readBytes,
        heapMiB: process.memoryUsage().heapUsed / 1048576 }, null, 2)}\n`);
    process.stdout.write('Mock DOM and serial layout; excludes browser paint and network latency.\n');
} finally {
    context.source.dispose();
}
