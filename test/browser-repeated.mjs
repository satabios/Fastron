import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { writeRepeatedModel } from './repeated-fixtures.mjs';

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'fastron-browser-repeated-'));
const source = new URL('../source/', import.meta.url);
const fixtures = new Map(['safetensors', 'gguf', 'onnx'].map((format) => {
    const { file } = writeRepeatedModel(folder, format);
    return [`/repeated.${format}`, file];
}));
await fs.mkdir(path.join(folder, 'large'));
fixtures.set('/large.safetensors', writeRepeatedModel(path.join(folder, 'large'), 'safetensors', 256).file);
if (process.argv[2]) {
    fixtures.set('/efficientvit.onnx', path.resolve(process.argv[2]));
}
if (process.argv[3]) {
    fixtures.set('/qwen.onnx', path.resolve(process.argv[3]));
}
if (process.argv[4]) {
    fixtures.set('/qwen-vision.onnx', path.resolve(process.argv[4]));
}
if (process.argv[5]) {
    fixtures.set('/resnet.onnx', path.resolve(process.argv[5]));
}
let transferred = 0;
let nativeCacheRequests = 0;
const errors = [];
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/model-source-cache.mjs') {
            nativeCacheRequests++;
        }
        if (fixtures.has(url.pathname)) {
            const file = await fs.open(fixtures.get(url.pathname));
            try {
                const length = (await file.stat()).size;
                const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
                const start = range ? Number(range[1]) : 0;
                const end = range ? Number(range[2]) + 1 : length;
                response.writeHead(range ? 206 : 200, {
                    'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
                    'Content-Length': end - start, ETag: '"repeated-v1"',
                    ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${length}` } : {})
                });
                if (request.method === 'HEAD') {
                    response.end();
                } else {
                    const bytes = Buffer.alloc(end - start);
                    await file.read(bytes, 0, bytes.length, start);
                    transferred += bytes.length;
                    response.end(bytes);
                }
            } finally {
                await file.close();
            }
        } else {
            const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            const body = await fs.readFile(new URL(name, source));
            const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
            response.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream' });
            response.end(body);
        }
    } catch {
        response.writeHead(404);
        response.end();
    }
});
await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser = null;
try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.FASTRON_BROWSER_EXECUTABLE || undefined });
    const check = async (format) => {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [{ origin,
            localStorage: [{ name: 'options', value: JSON.stringify({ foldRepeatedBlocks: true }) }] }] } });
        await context.addCookies([{ name: 'consent', value: '1', url: origin }]);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on('pageerror', (error) => errors.push(error.message));
        const before = transferred;
        await page.goto(`${origin}/?url=/repeated.${format}&identifier=repeated.${format}`);
        const foldedNodes = 2;
        const nodes = page.locator('#canvas .graph-node');
        try {
            await expect(nodes).toHaveCount(48, { timeout: 30000 });
            await expect(page.locator('.node-item-repeat')).toHaveCount(0);
            await expect(page.locator('body')).toHaveClass(/default/);
            const initialBytes = transferred;
            const stacking = page.getByRole('button', { name: 'Graph Stacking', exact: true });
            await expect(stacking).toBeVisible();
            await expect(stacking).toBeEnabled();
            await expect(stacking).toHaveAttribute('aria-pressed', 'false');
            await stacking.focus();
            await stacking.press('Enter');
            await expect(nodes).toHaveCount(foldedNodes, { timeout: 30000 });
            await expect(stacking).toHaveAttribute('aria-pressed', 'true');
            await expect(stacking).toHaveClass(/active/);
            await expect(stacking).toHaveAttribute('title', 'Show Ungrouped Graph');
            assert.equal(transferred, initialBytes, 'Enabling folding cannot fetch weights.');
            await expect(page.locator('body')).toHaveClass(/default/);
            await expect(page.locator('.node-item-repeat text')).toHaveText('×24 modules');
            await page.screenshot({ path: path.join(os.tmpdir(), `fastron-repeated-${format}.png`) });
            assert.ok(transferred - before < 131072, `Unexpected model transfer: ${transferred - before}`);
            const metadataBytes = transferred;
            await page.locator('.node-item-repeat').click();
            await page.getByLabel('Representative layer').selectOption('17');
            await expect(page.getByLabel('Representative layer')).toHaveValue('17');
            await expect(nodes).toHaveCount(foldedNodes);
            await page.locator('#canvas').getByRole('button', { name: 'Expand stack', exact: true }).click();
            await expect(nodes).toHaveCount(48);
            const fold = page.locator('#canvas').getByRole('button', { name: 'Fold stack', exact: true });
            await expect(fold).toBeVisible();
            await expect(fold).toHaveAttribute('aria-expanded', 'true');
            await fold.focus();
            await fold.press('Enter');
            await expect(nodes).toHaveCount(foldedNodes);
            const expand = page.locator('#canvas').getByRole('button', { name: 'Expand stack', exact: true });
            await expect(expand).toBeVisible();
            await expect(expand).toHaveAttribute('aria-expanded', 'false');
            assert.equal(transferred, metadataBytes, 'Selecting, expanding and folding must not fetch weights.');
            await page.locator('#menu-button').click();
            await page.locator('button:has-text("Find...")').first().click();
            const identifier = { onnx: 'encoder.layers.7.weight', gguf: 'blk.7.q_proj.weight', safetensors: 'encoder.layers.7.q_proj.weight' }[format];
            await page.locator('#search').fill(identifier);
            await page.locator('.sidebar-find-content li').filter({ hasText: identifier }).first().dblclick();
            const entry = page.locator('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"])');
            await expect(entry).toBeVisible();
            await entry.locator('.sidebar-item-value-button').first().click();
            await expect(entry.locator('pre')).toContainText('Click to load on demand');
            assert.equal(transferred, metadataBytes, 'Hidden-layer search and metadata inspection must not fetch weights.');
            await page.locator('#weights-toggle-button').click();
            await expect(page.locator('#weights-toggle-button')).toHaveClass(/weights-enabled/);
            await expect(page.locator('body')).toHaveClass(/default/);
            await expect(nodes).toHaveCount(foldedNodes);
            assert.equal(transferred, metadataBytes, 'Enabling weights must not bulk-load the model.');
            await page.locator('#menu-button').click();
            await page.locator('button:has-text("Find...")').first().click();
            await page.locator('#search').fill(identifier);
            await page.locator('.sidebar-find-content li').filter({ hasText: identifier }).first().dblclick();
            const previewBytes = transferred;
            await entry.locator('.sidebar-item-value-button').first().click();
            await expect(entry.locator('pre').last()).toContainText('70');
            assert.equal(transferred - previewBytes, 4000);
            await page.locator('#menu-button').click();
            const download = page.waitForEvent('download');
            await page.locator('button:has-text("Export as SVG")').first().click();
            const exported = await download;
            const svg = await fs.readFile(await exported.path(), 'utf-8');
            assert.match(svg, /×24/);
            const exportedNodes = (svg.match(/class="[^"]*"/g) || []).filter((attr) => attr.slice(7, -1).split(/\s+/).includes('graph-node'));
            assert.equal(exportedNodes.length, foldedNodes);
            await page.locator('#menu-button').click();
            await page.locator('button:has-text("Show Ungrouped Graph")').first().click();
            await expect(nodes).toHaveCount(48);
            await expect(stacking).toHaveAttribute('aria-pressed', 'false');
            await expect(stacking).not.toHaveClass(/active/);
            await stacking.click();
            await expect(nodes).toHaveCount(foldedNodes);
            await stacking.click();
            await expect(nodes).toHaveCount(48);
            await expect(page.locator('body')).toHaveClass(/default/);
            await page.locator('#menu-button').click();
            const expandedDownload = page.waitForEvent('download');
            await page.locator('button:has-text("Export as SVG")').first().click();
            const expandedSVG = await fs.readFile(await (await expandedDownload).path(), 'utf-8');
            assert.equal((expandedSVG.match(/class="[^"]*"/g) || []).filter((attr) => attr.slice(7, -1).split(/\s+/).includes('graph-node')).length, 48);
            assert.deepEqual(errors, []);
            process.stdout.write(`${format}: metadata-only navigation, on-demand weights, folding and SVG exports passed.\n`);
        } catch (error) {
            await page.screenshot({ path: path.join(os.tmpdir(), 'fastron-repeat-failure.png') });
            process.stderr.write(`${format}: ${(await page.locator('body').innerText()).slice(0, 1500)}\n`);
            throw error;
        } finally {
            await context.close();
        }
    };
    const checkHierarchy = async (file, expected) => {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        await context.addCookies([{ name: 'consent', value: '1', url: origin }]);
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        try {
            await page.goto(`${origin}/?url=${file}&identifier=${file.slice(1)}`);
            await expect(page.locator('body')).toHaveClass(/default/, { timeout: 30000 });
            const stacking = page.getByRole('button', { name: 'Graph Stacking', exact: true });
            await expect(stacking).toBeEnabled();
            const cdp = await context.newCDPSession(page);
            const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
            const count = () => evaluate('window.__view__._target?._displayGraph.nodes.length');
            const original = await count();
            const metadataBytes = transferred;
            const start = performance.now();
            await stacking.click();
            await expect(stacking).toBeEnabled();
            await expect.poll(count).toBe(expected);
            const elapsed = performance.now() - start;
            assert.equal(transferred, metadataBytes, 'Grouping cannot fetch parameters.');
            await expect(page.locator('.node-item-repeat')).toHaveCount(0);
            const selected = await evaluate(`(() => {
                const view = window.__view__;
                let selected = null;
                for (const node of view._target._groupNodes.values()) {
                    const group = node.value?._hierarchyGroup;
                    if (group) {
                        selected ||= node;
                        if (group.label === 'blocks.13') {
                            selected = node;
                            break;
                        }
                    }
                }
                if (!selected) {
                    return null;
                }
                view._target.scrollToValue(selected.value, 'instant');
                const group = selected.value._hierarchyGroup;
                return { id: group.id, label: group.label };
            })()`);
            assert.ok(selected);
            await page.getByRole('button', { name: `Expand ${selected.label}`, exact: true }).first().click();
            await expect(stacking).toBeEnabled();
            assert.ok(await count() > expected);
            await expect(page.locator('#canvas .edge-label').first()).toBeAttached();
            await page.screenshot({ path: path.join(os.tmpdir(), `fastron-grouped-${file.slice(1)}.png`), animations: 'disabled' });
            await page.emulateMedia({ colorScheme: 'dark' });
            await page.screenshot({ path: path.join(os.tmpdir(), `fastron-grouped-${file.slice(1)}-dark.png`), animations: 'disabled' });
            await page.emulateMedia({ colorScheme: 'light' });
            await page.getByRole('button', { name: `Collapse ${selected.label}`, exact: true }).first().click();
            await expect(stacking).toBeEnabled();
            await expect.poll(count).toBe(expected);
            assert.equal(transferred, metadataBytes, 'Expanding real groups cannot fetch weights.');
            if (file === '/repeated.onnx') {
                const findWeight = async () => {
                    await page.locator('#menu-button').click();
                    await page.locator('button:has-text("Find...")').first().click();
                    await page.locator('#search').fill('encoder.layers.7.weight');
                    await page.locator('.sidebar-find-content li').filter({ hasText: 'encoder.layers.7.weight' }).first().dblclick();
                };
                await findWeight();
                const entry = page.locator('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"])');
                await entry.locator('.sidebar-item-value-button').first().click();
                await expect(entry.locator('pre')).toContainText('Click to load on demand');
                assert.equal(transferred, metadataBytes);
                await page.locator('#weights-toggle-button').click();
                await expect(stacking).toBeEnabled();
                await findWeight();
                const previewBytes = transferred;
                await entry.locator('.sidebar-item-value-button').first().click();
                await expect(entry.locator('pre').last()).toContainText('70');
                assert.equal(transferred - previewBytes, 4000);
            }
            const grouped = await count();
            await page.locator('#menu-button').click();
            const download = page.waitForEvent('download');
            await page.locator('button:has-text("Export as SVG")').first().click();
            const svg = await fs.readFile(await (await download).path(), 'utf-8');
            assert.equal((svg.match(/class="[^"]*"/g) || []).filter((attr) => attr.slice(7, -1).split(/\s+/).includes('graph-node')).length, grouped);
            await stacking.click();
            await expect(stacking).toBeEnabled();
            await expect.poll(count).toBe(original);
            await stacking.click();
            await expect(stacking).toBeEnabled();
            await expect.poll(count).toBe(grouped);
            assert.deepEqual(errors, []);
            process.stdout.write(`${file}: hierarchy ${original} → ${expected} in ${Math.round(elapsed)} ms, shapes, real-instance inspection and SVG export passed.\n`);
        } finally {
            await context.close();
        }
    };
    await check('safetensors');
    await check('gguf');
    await checkHierarchy('/repeated.onnx', 24);
    const context = await browser.newContext();
    await context.addCookies([{ name: 'consent', value: '1', url: origin }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?url=/large.safetensors&identifier=large.safetensors`);
    await expect(page.locator('body')).toHaveClass(/default/);
    await expect(page.locator('.node-item-repeat')).toHaveCount(0);
    await page.locator('#menu-button').click();
    await page.locator('button:has-text("Group Model")').first().click();
    await expect(page.locator('.node-item-repeat text')).toHaveText('×256 modules');
    const metadataBytes = transferred;
    await page.locator('.node-item-repeat').click();
    await page.locator('#sidebar-content').getByText('Expand stack', { exact: true }).click();
    await expect(page.locator('#sidebar-content').getByText('Fold stack', { exact: true })).toBeVisible();
    assert.ok(await page.locator('#canvas .graph-node').count() < 512);
    const overview = page.locator('#canvas .graph-node.node-overview');
    for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await page.locator('#zoom-out-button').click();
    }
    await expect(overview.first()).toBeVisible();
    await expect(overview.first()).toHaveAttribute('role', 'button');
    await expect(page.locator('.node-overview-label:visible').first()).toHaveText('Module');
    await overview.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#canvas .graph-node.select:not(.node-overview)')).toHaveCount(1);
    await expect(page.locator('#sidebar-content')).toBeVisible();
    for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await page.locator('#zoom-in-button').click();
    }
    await expect(overview).toHaveCount(0);
    for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await page.locator('#zoom-out-button').click();
    }
    await expect(overview.first()).toBeVisible();
    await page.screenshot({ path: path.join(os.tmpdir(), 'fastron-overview.png') });
    assert.equal(transferred, metadataBytes, 'Zoom and keyboard activation cannot fetch weights.');
    await page.locator('#menu-button').click();
    await page.locator('button:has-text("Find...")').first().click();
    await page.locator('#search').fill('encoder.layers.217.q_proj.weight');
    await page.locator('.sidebar-find-content li').filter({ hasText: 'encoder.layers.217.q_proj.weight' }).dblclick();
    const entry = page.locator('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"])');
    await entry.locator('.sidebar-item-value-button').first().click();
    await expect(entry.locator('pre')).toContainText('Click to load on demand');
    assert.equal(transferred, metadataBytes);
    await entry.locator('pre').click();
    await expect(entry.locator('pre').last()).toContainText('2170');
    assert.equal(transferred - metadataBytes, 4000);
    await page.locator('#menu-button').click();
    const download = page.waitForEvent('download');
    await page.locator('button:has-text("Export as SVG")').first().click();
    const svg = await fs.readFile(await (await download).path(), 'utf-8');
    assert.equal((svg.match(/class="[^"]*"/g) || []).filter((attr) => attr.slice(7, -1).split(/\s+/).includes('graph-node')).length, 512);
    assert.doesNotMatch(svg, /node-overview/);
    await expect(overview.first()).toBeVisible();
    await page.locator('#menu-button').click();
    await page.locator('button:has-text("Show Ungrouped Graph")').first().click();
    await expect(page.locator('body')).toHaveClass(/default/);
    await page.locator('#menu-button').click();
    await page.locator('button:has-text("Group Model")').first().click();
    await expect(page.locator('#canvas .graph-node')).toHaveCount(2);
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write('512-node expanded stack: viewport eviction, overview zoom/keyboard access, distant real weights, full SVG export and folding passed.\n');
    for (const [file, expected] of [
        ['/efficientvit.onnx', 3], ['/qwen.onnx', 585], ['/qwen-vision.onnx', 39], ['/resnet.onnx', 10]
    ]) {
        if (fixtures.has(file)) {
            // eslint-disable-next-line no-await-in-loop
            await checkHierarchy(file, expected);
        }
    }

    assert.equal(nativeCacheRequests, 0, 'Browser loading must not fetch the native metadata cache.');
} finally {
    await browser?.close();
    await new Promise((resolve) => {
        server.close(resolve);
    });
    await fs.rm(folder, { recursive: true, force: true });
}
