// Run: node test/benchmark-repeated.mjs [--latency=10]
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nodeCatalog, repeatedBlocks } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { ModelFactoryService } from '../source/view.js';
import { createContext } from '../source/model-source.mjs';
import { execFileSync } from 'node:child_process';
import { indexSource } from '../source/model-index.mjs';
import { layout } from '../source/dagre.js';
import { writeRepeatedModel } from './repeated-fixtures.mjs';

const args = process.argv.slice(2);
const latency = Number(args.find((arg) => arg.startsWith('--latency='))?.slice(10) || 0);
assert.ok(Number.isFinite(latency) && latency >= 0, 'Latency must be nonnegative milliseconds.');
const parent = args[0] !== '--child';
if (parent) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-repeat-bench-'));
    try {
        const rows = [];
        for (const format of ['safetensors', 'gguf', 'onnx']) {
            for (const count of [24, 96, 256]) {
                const { file } = writeRepeatedModel(folder, format, count);
                for (const mode of ['expanded', 'folded']) {
                    rows.push(JSON.parse(execFileSync(process.execPath, ['--expose-gc', import.meta.filename,
                        '--child', file, format, String(count), mode, `--latency=${latency}`], { encoding: 'utf-8' })));
                }
            }
        }
        process.stdout.write(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
        process.stdout.write('Fresh processes; sparse 4 MiB tensors. Layout uses fixed 150×65 nodes and actual data edges, not browser paint. Heap includes metadata; simulated latency applies to every source read.\n');
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
} else {
    const [, file, format, layers, mode] = args;
    const fd = fs.openSync(file, 'r');
    try {
        let bytes = 0;
        let requests = 0;
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const source = {
            length: fs.fstatSync(fd).size,
            readSync(offset, target) {
                if (latency) {
                    Atomics.wait(wait, 0, 0, latency);
                }
                bytes += target.length;
                requests++;
                let read = 0;
                while (read < target.length) {
                    const count = fs.readSync(fd, target, read, target.length - read, offset + read);
                    assert.ok(count > 0, 'Truncated fixture.');
                    read += count;
                }
            }
        };
        const started = performance.now();
        const descriptor = await indexSource(source, { onnx: 1, gguf: 2, safetensors: 3 }[format]);
        descriptor.name = path.basename(file);
        const host = new Host({});
        const context = createContext(host, descriptor, async (descriptor, offset, length) => {
            const buffer = new Uint8Array(length);
            source.readSync(offset, buffer);
            return buffer;
        });
        const graph = (await new ModelFactoryService(host).open(context)).modules[0];
        const openMs = performance.now() - started;
        const start = performance.now();
        const analysis = mode === 'folded' ? await repeatedBlocks(graph) : null;
        const display = analysis ? analysis.project() : graph;
        const nodes = Array.from(display.nodes, (_, i) => ({ v: String(i), width: 150, height: 65 }));
        const prepareMs = performance.now() - start;
        assert.equal(nodes.length, mode === 'folded' ? 2 : Number(layers) * 2);
        const producers = new Map();
        display.nodes.forEach((node, i) => node.outputs.forEach((arg) => arg.value.forEach((value) => producers.set(value.name, i))));
        const edges = [];
        display.nodes.forEach((node, i) => node.inputs.forEach((arg) => arg.value.forEach((value) => {
            if (!value.initializer && producers.has(value.name)) {
                edges.push({ v: String(producers.get(value.name)), w: String(i), minlen: 1, weight: 1 });
            }
        })));
        const layoutStart = performance.now();
        layout(nodes, edges, { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: 'tb' }, {});
        const layoutMs = performance.now() - layoutStart;
        global.gc();
        const heapMiB = process.memoryUsage().heapUsed / 1048576;
        const richNodes = nodeCatalog(graph.nodes).cache.size;
        const openBytes = bytes;
        const openRequests = requests;
        if (analysis) {
            nodeCatalog(graph.nodes).release();
        }
        const selected = analysis ? analysis.project(new Map([[0, 17]])) : graph;
        const node = selected.nodes[analysis ? 0 : 34];
        const tensor = node.inputs.flatMap((arg) => arg.value).find((value) => value.initializer).initializer;
        await tensor.preview(1);
        assert.equal(bytes - openBytes, 4, 'Preview must read only the selected value.');
        const round = (value) => Math.round(value * 100) / 100;
        process.stdout.write(JSON.stringify({ format, layers: Number(layers), mode, richNodes, openBytes, openRequests,
            openMs: round(openMs), prepareMs: round(prepareMs), layoutMs: round(layoutMs), heapMiB: round(heapMiB), previewBytes: bytes - openBytes }));
    } finally {
        fs.closeSync(fd);
    }
}
