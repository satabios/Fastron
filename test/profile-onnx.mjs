// node --import ./test/profile-source-preload.mjs test/profile-onnx.mjs <model> <output directory>
import { Session } from 'node:inspector';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const filename = process.argv[2];
const folder = path.resolve(process.argv[3] || 'dist/profile-orion/run-1');
fs.mkdirSync(folder, { recursive: true });
process.env.FASTRON_PROFILE_DIR = folder;
globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true } };
const { Host } = await import('./mock.js');
const { Graph, ModelFactoryService, View } = await import('../source/view.js');
const { openSource } = await import('../source/model-source.mjs');
const host = new Host({ serial: true });
host.require = (id) => import(pathToFileURL(path.resolve('source', `${id}.js`)).href);
const session = new Session();
session.connect();
const post = (method) => new Promise((resolve, reject) => {
    session.post(method, (error, result) => error ? reject(error) : resolve(result));
});
await post('Profiler.enable');
await post('Profiler.start');
const report = { filename, started: new Date().toISOString(), node: process.version,
    scope: 'Network source/index/parse plus mock-DOM serial graph preparation/layout/tile indexing. Not Electron paint or FPS. Profiler overhead included; caches uncontrolled.',
    phases: {}, memory: {} };
const save = () => fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2));
let previous = performance.now();
const phase = (name) => {
    const now = performance.now();
    report.phases[name] = now - previous;
    report.memory[name] = process.memoryUsage();
    save();
    process.stdout.write(`${name}: ${report.phases[name].toFixed(2)} ms\n`);
    previous = performance.now();
};
let context = null;
try {
    context = await openSource(host, { path: filename });
    phase('sourceOpenAndIndex');
    report.descriptor = { kind: context.indexedFormat, metadataBytes: context.stream.length,
        tensorRanges: context.stream.tensorRanges?.length };
    const model = await new ModelFactoryService(host).open(context);
    assert.equal(host.errors.length, 0);
    phase('parse');
    report.model = { format: model.format, nodes: model.modules[0].nodes.length };
    const before = await context.source.request('stats');
    report.source = before;
    const view = new View(host);
    view.model = model;
    const graph = new Graph(view, model.modules[0].groups || false);
    graph.enableViewportCulling(true, 300);
    graph.configureDeferredRendering({ deferredNodeBuild: true, deferredEdgeBuild: true,
        skipHiddenUpdate: true, detachInvisible: true, estimatedNodeSizeThreshold: 500 });
    const display = await view._repeatedPresentation(model.modules[0], () => true);
    assert.equal(view.options.foldRepeatedBlocks, false);
    graph.add(display);
    graph.build(host.document);
    await graph.measure();
    phase('prepareAndMeasure');
    assert.equal(await graph.layout(null), '');
    phase('layout');
    graph.update();
    phase('update');
    graph.populateTiles();
    graph.compactLayout();
    phase('tilesAndCompact');
    let routePoints = 0;
    for (const edge of graph.edges.values()) {
        assert.ok(edge.label.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
        routePoints += edge.label.points.length;
    }
    const after = await context.source.request('stats');
    report.graph = { nodes: graph.nodes.size, edges: graph.edges.size, routePoints,
        sourceBytesDuringRendering: after.readBytes - before.readBytes };
    assert.equal(report.graph.sourceBytesDuringRendering, 0);
    report.status = 'ok';
} catch (error) {
    report.status = 'error';
    report.error = error.stack;
    process.exitCode = 1;
} finally {
    if (context) {
        const captured = fs.readdirSync(folder).some((file) => /^worker-\d+\.cpuprofile$/.test(file));
        report.workerProfileCaptured = captured;
        if (!captured) {
            report.status = 'error';
            report.error = 'Worker profile capture did not complete.';
            process.exitCode = 1;
        }
        context.source.dispose();
    }
    const { profile } = await post('Profiler.stop');
    fs.writeFileSync(path.join(folder, 'main.cpuprofile'), JSON.stringify(profile));
    session.disconnect();
    report.peakRssMiB = process.resourceUsage().maxRSS / 1048576 * 1024;
    report.finished = new Date().toISOString();
    save();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}