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
const errors = [];
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://localhost');
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
    browser = await chromium.launch({ headless: true });
    const check = async (format) => {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [{ origin,
            localStorage: [{ name: 'options', value: JSON.stringify({ foldRepeatedBlocks: true }) }] }] } });
        await context.addCookies([{ name: 'consent', value: '1', url: origin }]);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.on('pageerror', (error) => errors.push(error.message));
        const before = transferred;
        await page.goto(`${origin}/?url=/repeated.${format}&identifier=repeated.${format}`);
        const foldedNodes = format === 'onnx' ? 1 : 2;
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
            await expect(stacking).toHaveAttribute('title', 'Expand Repeated Blocks');
            assert.equal(transferred, initialBytes, 'Enabling folding cannot fetch weights.');
            await expect(page.locator('body')).toHaveClass(/default/);
            await expect(page.locator('.node-item-repeat text')).toHaveText('×24');
            await page.screenshot({ path: path.join(os.tmpdir(), `fastron-repeated-${format}.png`) });
            assert.ok(transferred - before < 131072, `Unexpected model transfer: ${transferred - before}`);
            const metadataBytes = transferred;
            await page.locator('.node-item-repeat').click();
            await page.getByLabel(format === 'onnx' ? 'Representative instance' : 'Representative layer').selectOption('17');
            await expect(page.getByLabel(format === 'onnx' ? 'Representative instance' : 'Representative layer')).toHaveValue('17');
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
            await expect(nodes).toHaveCount(format === 'onnx' ? 48 : foldedNodes);
            assert.equal(transferred, metadataBytes, 'Enabling weights must not bulk-load the model.');
            await page.locator('#menu-button').click();
            await page.locator('button:has-text("Find...")').first().click();
            await page.locator('#search').fill(identifier);
            await page.locator('.sidebar-find-content li').filter({ hasText: identifier }).first().dblclick();
            const previewBytes = transferred;
            await entry.locator('.sidebar-item-value-button').first().click();
            await expect(entry.locator('pre').last()).toContainText('70');
            assert.equal(transferred - previewBytes, 4000);
            if (format === 'onnx') {
                await stacking.click();
                await expect(stacking).toHaveAttribute('aria-pressed', 'false');
                await stacking.click();
                await expect(nodes).toHaveCount(foldedNodes);
            }
            await page.locator('#menu-button').click();
            const download = page.waitForEvent('download');
            await page.locator('button:has-text("Export as SVG")').first().click();
            const exported = await download;
            const svg = await fs.readFile(await exported.path(), 'utf-8');
            assert.match(svg, /×24/);
            const exportedNodes = (svg.match(/class="[^"]*"/g) || []).filter((attr) => attr.slice(7, -1).split(/\s+/).includes('graph-node'));
            assert.equal(exportedNodes.length, foldedNodes);
            await page.locator('#menu-button').click();
            await page.locator('button:has-text("Expand Repeated Blocks")').first().click();
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
    await check('safetensors');
    await check('gguf');
    await check('onnx');
    const context = await browser.newContext();
    await context.addCookies([{ name: 'consent', value: '1', url: origin }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?url=/large.safetensors&identifier=large.safetensors`);
    await expect(page.locator('body')).toHaveClass(/default/);
    await expect(page.locator('.node-item-repeat')).toHaveCount(0);
    await page.locator('#menu-button').click();
    await page.locator('button:has-text("Fold Repeated Blocks")').first().click();
    await expect(page.locator('.node-item-repeat text')).toHaveText('×256');
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
    await page.locator('button:has-text("Expand Repeated Blocks")').first().click();
    await expect(page.locator('body')).toHaveClass(/default/);
    await page.locator('#menu-button').click();
    await page.locator('button:has-text("Fold Repeated Blocks")').first().click();
    await expect(page.locator('#canvas .graph-node')).toHaveCount(2);
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write('512-node expanded stack: viewport eviction, overview zoom/keyboard access, distant real weights, full SVG export and folding passed.\n');
    for (const [file, expected, repeats] of [
        ['/efficientvit.onnx', 39, [3, 5, 5, 8]],
        ['/qwen.onnx', 521, [3, 24]],
        ['/qwen-vision.onnx', 25, [3, 6]],
        ['/resnet.onnx', 14, [2, 3, 5, 2]]
    ]) {
        if (!fixtures.has(file)) {
            continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const context = await browser.newContext();
        // eslint-disable-next-line no-await-in-loop
        await context.addCookies([{ name: 'consent', value: '1', url: origin }]);
        // eslint-disable-next-line no-await-in-loop
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        // eslint-disable-next-line no-await-in-loop
        await page.goto(`${origin}/?url=${file}&identifier=${file.slice(1)}`);
        // eslint-disable-next-line no-await-in-loop
        await expect(page.locator('body')).toHaveClass(/default/, { timeout: 30000 });
        const stacking = page.getByRole('button', { name: 'Graph Stacking', exact: true });
        // eslint-disable-next-line no-await-in-loop
        await expect(stacking).toHaveAttribute('aria-pressed', 'false');
        const metadataBytes = transferred;
        // eslint-disable-next-line no-await-in-loop
        const cdp = await context.newCDPSession(page);
        const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
        const count = () => evaluate('window.__view__?._target?._displayGraph?.nodes.length');
        // eslint-disable-next-line no-await-in-loop
        const original = await count();
        // eslint-disable-next-line no-await-in-loop
        await stacking.click();
        // eslint-disable-next-line no-await-in-loop
        await expect.poll(count, { timeout: 30000 }).toBe(expected);
        // eslint-disable-next-line no-await-in-loop
        const groups = await evaluate('window.__view__._repeatStates.get(window.__view__.activeTarget).analysis.groups.map(g => ({ id: g.id, n: g.blocks.length, operators: g.members.length, detail: g.blocks[0].indices.length }))');
        assert.deepEqual(groups.filter((g) => g.n > 1).map((g) => g.n), repeats);
        const largest = groups.reduce((a, b) => a.n > b.n ? a : b);
        // eslint-disable-next-line no-await-in-loop
        await evaluate(`(() => {
            const view = window.__view__;
            for (const { label: node } of view._target.nodes.values()) {
                if (node._overviewType === '×${largest.n} Repeated pattern') {
                    view._target.scrollToValue(node.value, 'instant');
                    return;
                }
            }
        })()`);
        const badge = page.locator('.node-item-repeat').filter({ hasText: `×${largest.n}` });
        // eslint-disable-next-line no-await-in-loop
        await badge.click();
        const select = page.getByLabel('Representative instance');
        // eslint-disable-next-line no-await-in-loop
        await select.selectOption(String(largest.n - 1));
        // eslint-disable-next-line no-await-in-loop
        await expect.poll(count).toBe(expected);
        // eslint-disable-next-line no-await-in-loop
        await expect(page.locator('body')).toHaveClass(/default/);
        // eslint-disable-next-line no-await-in-loop
        await expect(badge).toBeVisible();
        // eslint-disable-next-line no-await-in-loop
        await page.screenshot({ path: path.join(os.tmpdir(), `fastron-generic-${file.slice(1)}.png`) });
        const card = page.locator('#canvas .graph-node').filter({ has: badge });
        // eslint-disable-next-line no-await-in-loop
        await card.getByRole('button', { name: 'Expand stack', exact: true }).click();
        // eslint-disable-next-line no-await-in-loop
        await expect.poll(count).toBe(expected + largest.operators - 1);
        // eslint-disable-next-line no-await-in-loop
        await page.locator('#canvas').getByRole('button', { name: 'Fold stack', exact: true }).click();
        // eslint-disable-next-line no-await-in-loop
        await expect.poll(count).toBe(expected);
        if (file === '/efficientvit.onnx') {
            // eslint-disable-next-line no-await-in-loop
            await page.locator('#menu-button').click();
            const download = page.waitForEvent('download');
            // eslint-disable-next-line no-await-in-loop
            await page.locator('button:has-text("Export as SVG")').first().click();
            // eslint-disable-next-line no-await-in-loop
            const svg = await fs.readFile(await (await download).path(), 'utf-8');
            assert.equal((svg.match(/class="[^"]*"/g) || []).filter((attr) => attr.slice(7, -1).split(/\s+/).includes('graph-node')).length, expected);
            // eslint-disable-next-line no-await-in-loop
            await stacking.click();
            // eslint-disable-next-line no-await-in-loop
            await expect.poll(count).toBe(original);
            // eslint-disable-next-line no-await-in-loop
            await stacking.click();
            // eslint-disable-next-line no-await-in-loop
            await expect.poll(count).toBe(expected);
        }
        // eslint-disable-next-line no-await-in-loop
        await badge.click();
        // eslint-disable-next-line no-await-in-loop
        await page.getByText('Open module', { exact: true }).click();
        // eslint-disable-next-line no-await-in-loop
        await expect.poll(() => evaluate('Boolean(window.__view__.activeTarget?._patternRegion && window.__view__._target?._renderTarget === window.__view__.activeTarget)')).toBe(true);
        // eslint-disable-next-line no-await-in-loop
        await expect.poll(count).toBeGreaterThan(0);
        // eslint-disable-next-line no-await-in-loop
        assert.ok(await count() <= largest.detail);
        assert.equal(transferred, metadataBytes, 'Generic matching, selection, expansion and navigation cannot fetch weights.');
        assert.deepEqual(errors, []);
        // eslint-disable-next-line no-await-in-loop
        await context.close();
        process.stdout.write(`${file}: generic topology folding ${original} → ${expected}, per-instance navigation and zero weight reads passed.\n`);
    }

} finally {
    await browser?.close();
    await new Promise((resolve) => {
        server.close(resolve);
    });
    await fs.rm(folder, { recursive: true, force: true });
}
