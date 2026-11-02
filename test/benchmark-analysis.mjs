import * as assert from 'node:assert/strict';
import { Controller } from '../source/comparator.js';
import { GraphAnalysis } from '../source/graph-analysis.mjs';

// Run after npm run build:index; timings include packing and worker transport, not just the kernel.
const graph = (count) => {
    const type = { dataType: 'float32', shape: { dimensions: ['batch', 64] } };
    const value = (name) => ({ name, type });
    const input = value('x');
    const nodes = [];
    let previous = input;
    for (let index = 0; index < count; index++) {
        const output = value(`v${index}`);
        nodes.push({ name: `/network/blocks.${Math.floor(index / 8)}/op${index}`, type: { name: index % 2 ? 'Relu' : 'MatMul', module: 'ai.onnx', version: 1 },
            inputs: [{ name: 'input', value: [previous] }], outputs: [{ name: 'output', value: [output] }], attributes: [] });
        previous = output;
    }
    return { nodes, inputs: [{ name: 'x', value: [input] }], outputs: [{ name: 'y', value: [previous] }] };
};
const sizes = process.argv.slice(2).map(Number);
for (const count of sizes.length ? sizes : [1000, 10000]) {
    assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 100000);
    const a = graph(count); const b = structuredClone(a);
    b.nodes[Math.floor(count / 2)].type.name = 'Sigmoid';
    const reference = Object.create(Controller.prototype);
    const before = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const expected = await new Promise((resolve) => {
        reference._compareNodesPhase2(reference._compareNodesPhase1(a, b), resolve);
    });
    const javascript = performance.now() - before;
    const analysis = new GraphAnalysis();
    try {
        const start = performance.now();
        // eslint-disable-next-line no-await-in-loop
        const result = await analysis.compare(a, b);
        const total = performance.now() - start;
        assert.equal(result.pairs.filter((pair) => pair.status === 'modified').length, expected.pairs.filter((pair) => pair.status === 'modified').length);
        const projectionStart = performance.now();
        // eslint-disable-next-line no-await-in-loop
        const projection = await analysis.project(result.a, new Set(), result.id, 0);
        const projectionMs = performance.now() - projectionStart;
        const warmStart = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await analysis.compare(a, b);
        const warm = performance.now() - warmStart;
        process.stdout.write(`${JSON.stringify({ nodes: count, javascript, rust: result.timing, total, warm, projection: projectionMs,
            visibleNodes: projection.nodes.length, peakRssMiB: process.resourceUsage().maxRSS / 1024, memoryMiB: process.memoryUsage().rss / 1048576 })}\n`);
    } finally {
        analysis.dispose();
    }
}
