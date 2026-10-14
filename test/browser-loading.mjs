import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { chromium, expect } from '@playwright/test';

const source = new URL('../source/', import.meta.url);
const varint = (value) => {
    const bytes = [];
    do {
        bytes.push((value & 127) | (value > 127 ? 128 : 0));
        value = Math.floor(value / 128);
    } while (value);
    return Buffer.from(bytes);
};
const field = (id, body) => {
    body = typeof body === 'string' ? Buffer.from(body) : body;
    return Buffer.concat([varint(id * 8 + 2), varint(body.length), body]);
};
const weights = Buffer.alloc(8 * 1024 * 1024);
weights.writeFloatLE(1.5, 0);
weights.writeFloatLE(-2, 4);
const tensor = Buffer.concat([field(1, varint(weights.length / 4)), Buffer.from([16, 1]), field(8, 'weight'), field(9, weights)]);
const model = Buffer.concat([Buffer.from([8, 8]), field(7, Buffer.concat([
    field(1, Buffer.concat([field(1, 'input'), field(1, 'weight'), field(2, 'output'), field(4, 'Add')])),
    field(5, tensor), field(11, field(1, 'input')), field(12, field(1, 'output'))
]))]);
const chain = Array.from({ length: 600 }, (_, i) => field(1, Buffer.concat([
    field(1, i === 0 ? 'input' : `value${i - 1}`), field(2, `value${i}`), field(4, 'Identity')
])));
const largeModel = Buffer.concat([Buffer.from([8, 8]), field(7, Buffer.concat([
    ...chain, field(1, Buffer.concat([field(1, 'value599'), field(1, 'weight'), field(2, 'output'), field(4, 'Add')])),
    field(5, tensor), field(11, field(1, 'input')), field(12, field(1, 'output'))
]))]);
let transferred = 0;
const assets = new Set();
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/model.onnx' || url.pathname === '/large.onnx') {
            const payload = url.pathname === '/large.onnx' ? largeModel : model;
            const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
            const start = range ? Number(range[1]) : 0;
            const end = range ? Number(range[2]) + 1 : payload.length;
            response.writeHead(range ? 206 : 200, {
                'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes',
                'Content-Length': end - start, ETag: '"fixture-v1"',
                ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${payload.length}` } : {})
            });
            if (request.method === 'HEAD') {
                response.end();
            } else {
                transferred += end - start; response.end(payload.subarray(start, end));
            }
        } else {
            const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            assets.add(name);
            const body = await fs.readFile(new URL(name, source));
            const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
            response.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream' });
            response.end(body);
        }
    } catch {
        response.writeHead(404); response.end();
    }
});
await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser = null;
try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([{ name: 'consent', value: '1', url: origin }]);
    const check = async (input) => {
        const beforeOpen = transferred;
        const name = input === 'large' ? 'large.onnx' : 'model.onnx';
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => {
            errors.push(error.message); process.stderr.write(`${error.message}\n`);
        });
        page.on('console', (message) => {
            if (message.type() === 'error') {
                process.stderr.write(`${message.text()}\n`);
            }
        });
        await page.goto(input === 'file' ? origin : `${origin}/?url=/${name}&identifier=${name}`);
        if (input === 'file') {
            await page.locator('#open-file-dialog').setInputFiles({ name: 'model.onnx', mimeType: 'application/octet-stream', buffer: model });
        }
        try {
            await expect(page.locator('#canvas')).toBeVisible({ timeout: 30000 });
        } catch (error) {
            process.stderr.write(`${await page.locator('body').innerText()}\n`);
            throw error;
        }
        assert.ok(await page.locator('#canvas g').count() > 0);
        assert.ok(transferred - beforeOpen < 131072, `Unexpected weight download: ${transferred - beforeOpen}`);
        await page.locator('#menu-button').click();
        await page.locator('button:has-text("Find...")').first().click();
        await page.locator('#search').fill('weight');
        await page.locator('.sidebar-find-content li:has-text("weight")').first().dblclick();
        const entry = page.locator('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"])');
        await entry.locator('.sidebar-item-value-button').first().click();
        await expect(entry.locator('pre')).toContainText('Click to load on demand');
        const before = transferred;
        await entry.locator('pre').click();
        await expect(entry.locator('pre').last()).toContainText('1.5');
        await expect(entry.locator('pre').last()).toContainText('-2');
        await expect(entry.locator('pre').last()).toContainText('First 1000');
        assert.equal(transferred - before, input === 'file' ? 0 : 4000);
        assert.deepEqual(errors, []);
        await page.close();
    };
    await check('http');
    await check('file');
    await check('large');
    for (const name of ['pytorch.js', 'tflite.js', 'tflite-schema.js', 'mlnet.js']) {
        assert.equal(assets.has(name), false, `Unrelated decoder loaded: ${name}`);
    }
    process.stdout.write('Browser HTTP, file and 601-node graph: topology rendered, bounded previews, no unrelated decoders.\n');
} finally {
    await browser?.close();
    await new Promise((resolve) => {
        server.close(resolve);
    });
}
