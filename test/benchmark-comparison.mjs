import * as assert from 'node:assert/strict';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { _electron } from '@playwright/test';

// Compare real loading/layout/rendering with the committed baseline in isolated Electron windows.
const root = url.fileURLToPath(new URL('../', import.meta.url));
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'fastron-comparison-benchmark-'));
const source = (name) => url.pathToFileURL(path.join(root, 'source', name)).href;
const model = (count) => {
    const tensor = (name) => ({ name, type: { tensor_type: { elem_type: 1, shape: { dim: [{ dim_value: 1 }, { dim_value: 64 }] } } } });
    return { ir_version: 8, opset_import: [{ domain: '', version: 20 }], graph: { name: 'Benchmark', input: [tensor('x')], output: [tensor(`v${count - 1}`)],
        value_info: Array.from({ length: count }, (_, i) => tensor(`v${i}`)),
        node: Array.from({ length: count }, (_, i) => ({ name: `/network/blocks.${Math.floor(i / 8)}/op${i}`,
            op_type: i % 2 ? 'Relu' : 'Abs', input: [i === 0 ? 'x' : `v${i - 1}`], output: [`v${i}`], attribute: [] })) } };
};
assert.ok(process.env.FASTRON_BASELINE, 'Set FASTRON_BASELINE to the revision with the JavaScript comparator.');
const baseline = child_process.execFileSync('git', ['show', `${process.env.FASTRON_BASELINE}:source/comparator.js`], { cwd: root, encoding: 'utf-8' })
    .replaceAll("'./view.js'", JSON.stringify(source('view.js')));
const baselinePath = path.join(folder, 'baseline.mjs');
await fs.writeFile(baselinePath, baseline);
const html = await fs.readFile(path.join(root, 'source/comparator.html'), 'utf-8');
const sizes = process.env.FASTRON_MODEL ? [0] : process.argv.slice(2).map(Number);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app = null;
try {
    app = await _electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${path.join(folder, 'profile')}`], cwd: root, env });
    await app.firstWindow();
    for (const count of sizes.length ? sizes : [128, 1024]) {
        assert.ok(process.env.FASTRON_MODEL || (Number.isSafeInteger(count) && count > 0 && count <= 10000));
        const a = path.join(folder, 'a.onnx'); const b = path.join(folder, 'b.onnx');
        if (process.env.FASTRON_MODEL) {
            // eslint-disable-next-line no-await-in-loop
            const bytes = await fs.readFile(process.env.FASTRON_MODEL);
            // eslint-disable-next-line no-await-in-loop
            await fs.writeFile(a, bytes);
            // eslint-disable-next-line no-await-in-loop
            await fs.writeFile(b, bytes);
        } else {
            const input = model(count);
            // eslint-disable-next-line no-await-in-loop
            await fs.writeFile(a, JSON.stringify(input));
            input.graph.node[Math.floor(count / 2)].op_type = 'Sigmoid';
            // eslint-disable-next-line no-await-in-loop
            await fs.writeFile(b, JSON.stringify(input));
        }
        for (const backend of ['javascript', 'rust']) {
            const controllerUrl = backend === 'rust' ? source('comparator.js') : url.pathToFileURL(baselinePath).href;
            const preload = path.join(folder, `preload-${backend}.mjs`);
            // eslint-disable-next-line no-await-in-loop
            await fs.writeFile(preload, `
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Controller } from ${JSON.stringify(controllerUrl)};
import { Graph } from ${JSON.stringify(source('view.js'))};
import { BinaryStream } from ${JSON.stringify(source('base.js'))};
import { Host, Context } from ${JSON.stringify(url.pathToFileURL(path.join(root, 'test/mock.js')).href)};
const metrics = { layout: 0, measure: 0, build: 0, update: 0 };
let started = 0;
let restored = 0;
let firstGraph = 0;
let analysisStart = 0;
const restore = Graph.prototype.restore;
Graph.prototype.restore = function(...args) {
    const result = restore.apply(this, args);
    if (++restored === 2) {
        requestAnimationFrame(() => requestAnimationFrame(() => { firstGraph = performance.now() - started; }));
    }
    return result;
};
for (const name of ['layout', 'measure']) {
    const original = Graph.prototype[name];
    Graph.prototype[name] = async function(...args) {
        const start = performance.now();
        try { return await original.apply(this, args); } finally { metrics[name] += performance.now() - start; }
    };
}
for (const name of ['build', 'update']) {
    const original = Graph.prototype[name];
    Graph.prototype[name] = function(...args) {
        const start = performance.now();
        try { return original.apply(this, args); } finally { metrics[name] += performance.now() - start; }
    };
}
class WindowHost extends Host {
    get document() { return window.document; }
    get window() { return window; }
    worker(id) {
        if (id === './analysis-worker') {
            if (!firstGraph) { throw new Error('Analysis started before the first graph painted'); }
            analysisStart = performance.now() - started;
        }
        return new window.Worker(new URL(id + '.js', ${JSON.stringify(source('comparator.js'))}), { type: 'module' }); }
    async _context(file) {
        const bytes = await fs.readFile(file);
        return new Context(this, path.dirname(file), path.basename(file), new BinaryStream(bytes));
    }
}
window.addEventListener('DOMContentLoaded', async () => {
    try {
        const host = new WindowHost({ serial: true });
        const controller = new Controller(host);
        const start = performance.now();
        started = start;
        await controller.compare({path:${JSON.stringify(a)}}, {path:${JSON.stringify(b)}});
        if (controller._entry?.error) { throw new Error(controller._entry.error); }
        while (!document.getElementById('diff-summary').textContent || document.getElementById('diff-summary').textContent.includes('Matching…')) {
            if (performance.now() - start > 60000) { throw new Error(document.querySelector('.spinner-text').textContent); }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.benchmark = { nodes: controller._targetA.nodes.length, backend: ${JSON.stringify(backend)}, elapsed: performance.now() - start, firstGraph, analysisStart,
            stages: metrics, analysis: controller._entry?.result.timing, heapMiB: process.memoryUsage().heapUsed / 1048576,
            rssMiB: process.memoryUsage().rss / 1048576, summary: document.getElementById('diff-summary').textContent };
    } catch (error) { window.benchmark = { error: error.stack }; }
});
`);
            const windowPromise = app.waitForEvent('window');
            // eslint-disable-next-line no-await-in-loop
            await app.evaluate(async ({ BrowserWindow }, options) => {
                const window = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: {
                    preload: options.preload, nodeIntegration: true, contextIsolation: false, sandbox: false
                } });
                await window.loadURL(options.data, { baseURLForDataURL: options.base });
            }, { preload, data: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`, base: source('comparator.html') });
            // eslint-disable-next-line no-await-in-loop
            const page = await windowPromise;
            // eslint-disable-next-line no-await-in-loop
            await page.waitForFunction(() => window.benchmark, null, { timeout: 90000 });
            // eslint-disable-next-line no-await-in-loop
            const result = await page.evaluate(() => window.benchmark);
            assert.equal(result.error, undefined, result.error);
            assert.match(result.summary, new RegExp(`${process.env.FASTRON_MODEL ? 0 : 1} modified`));
            process.stdout.write(`${JSON.stringify(result)}\n`);
            // eslint-disable-next-line no-await-in-loop
            await page.close();
        }
    }
} finally {
    await app?.close();
    await fs.rm(folder, { recursive: true, force: true });
}
