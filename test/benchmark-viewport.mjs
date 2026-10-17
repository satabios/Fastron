// Run: node test/benchmark-viewport.mjs (fresh processes, 2,048 displayed nodes per format).
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Graph, ModelFactoryService, View } from '../source/view.js';
import { Host } from './mock.js';
import { execFileSync } from 'node:child_process';
import { openSource } from '../source/model-source.mjs';
import { writeRepeatedModel } from './repeated-fixtures.mjs';

if (process.argv[2] === '--child') {
    const [, , , format, mode] = process.argv;
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-viewport-bench-'));
    const { file } = writeRepeatedModel(folder, format, 1024, 4096);
    const host = new Host({ serial: true });
    const context = await openSource(host, { path: file });
    try {
        const model = await new ModelFactoryService(host).open(context);
        const canonical = model.modules[0];
        // A plain array models the previous retention behavior: all rich nodes stay alive.
        const display = mode === 'retained' ? { nodes: Array.from(canonical.nodes), inputs: canonical.inputs, outputs: canonical.outputs } : canonical;
        const view = new View(host);
        view.model = model;
        const graph = new Graph(view, false);
        graph.enableViewportCulling(true, 300);
        graph.configureDeferredRendering({ detachInvisible: true, estimatedNodeSizeThreshold: 500 });
        graph._detachedElementLimit = 64;
        const before = await context.source.request('stats');
        const started = performance.now();
        graph.add(display);
        graph.build(host.document);
        await graph.measure();
        await graph.layout(null);
        graph.populateTiles();
        if (mode !== 'retained') {
            graph.compactLayout();
        }
        const nodes = Array.from(graph.nodes.values(), (entry) => entry.label).filter((node) => node.class === 'graph-node');
        const pan = (node) => {
            const delta = graph.updateViewportVisibility({ x: node.x - 10, y: node.y - 10, width: 800, height: 600 });
            graph.updateVisibleElements(host.document, delta);
        };
        const renderStarted = performance.now();
        if (mode === 'detail' || mode === 'overview') {
            const idle = [];
            globalThis.requestIdleCallback = (callback) => idle.push(callback);
            const delta = graph.updateViewportVisibility({
                x: 0, y: 0, width: Math.max(...nodes.map((node) => node.x + node.width)),
                height: Math.max(...nodes.map((node) => node.y + node.height)), zoom: mode === 'overview' ? 0.25 : 1
            });
            graph.updateVisibleElements(host.document, delta);
            while (idle.length) {
                idle.shift()();
            }
            delete globalThis.requestIdleCallback;
        } else {
            pan(nodes[0]);
            pan(nodes[1024]);
            pan(nodes[2047]);
        }
        const renderMs = performance.now() - renderStarted;
        const prepareMs = performance.now() - started;
        assert.equal((await context.source.request('stats')).readBytes, before.readBytes, 'Rendering cannot fetch weights.');
        global.gc();
        const memory = process.memoryUsage();
        const count = nodes.filter((node) => node._value).length;
        assert.ok(mode === 'retained' || mode === 'detail' ? count === 2048 : count < 2048);
        const round = (value) => Math.round(value * 100) / 100;
        const elements = (element) => 1 + Array.from(new Set(element.childNodes)).reduce((sum, child) => sum + elements(child), 0);
        process.stdout.write(JSON.stringify({ format, mode, nodes: nodes.length, retainedModels: count,
            retainedHeaders: nodes.filter((node) => node._blocks.length).length,
            heapMiB: round(memory.heapUsed / 1048576), arrayBuffersMiB: round(memory.arrayBuffers / 1048576),
            prepareMs: round(prepareMs), renderMs: round(renderMs), nodeSvgElements: elements(graph._nodeGroupElement) - 1, sourceBytesDuringRender: 0,
            geometry: nodes.reduce((sum, node) => (sum + Math.round((node.x + node.y + node.width + node.height) * 1000)) | 0, 0) }));
    } finally {
        context.source.dispose();
        fs.rmSync(folder, { recursive: true, force: true });
    }
} else {
    for (const format of ['safetensors', 'gguf', 'onnx']) {
        const run = (mode) => JSON.parse(execFileSync(process.execPath,
            ['--expose-gc', import.meta.filename, '--child', format, mode], { encoding: 'utf-8' }));
        const retained = run(process.argv.includes('--overview') ? 'detail' : 'retained');
        const viewport = run(process.argv.includes('--overview') ? 'overview' : 'viewport');
        assert.equal(viewport.geometry, retained.geometry, 'Eviction must preserve layout.');
        process.stdout.write(`${JSON.stringify(retained)}\n${JSON.stringify(viewport)}\n`);
    }
    process.stdout.write('Node mock DOM; measures retained model/UI/route memory and layout, not browser paint or remote latency.\n');
}
