// Actual Electron UI; optional FASTRON_CHECK_TOOLS points at isolated npm tools.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

if (process.versions.electron) {
    if (process.env.FASTRON_CHECK_TOOLS) {
        const tools = pathToFileURL(path.join(process.env.FASTRON_CHECK_TOOLS, 'package.json')).href;
        const hook = `import { createRequire } from 'node:module';
            import { pathToFileURL } from 'node:url';
            const require = createRequire(${JSON.stringify(tools)});
            export async function resolve(specifier, context, nextResolve) {
                try { return await nextResolve(specifier, context); }
                catch (error) {
                    if (specifier !== 'electron-updater') { throw error; }
                    return nextResolve(pathToFileURL(require.resolve(specifier)).href, context);
                }
            }`;
        register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
    }
    await import('../source/app.js');
    // Dynamic dependency loading can finish after Electron's ready event.
    const { app, BrowserWindow } = await import('electron');
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) {
        app.emit('ready');
    }
} else {
    const require = createRequire(process.env.FASTRON_CHECK_TOOLS ? path.join(process.env.FASTRON_CHECK_TOOLS, 'package.json') : import.meta.url);
    const { _electron } = require('@playwright/test');
    const filename = process.argv[2];
    const output = path.resolve(process.argv[3] || 'dist/benchmark-onnx/desktop-opening.json');
    assert.ok(filename, 'Supply a model path and optional JSON output path.');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-desktop-benchmark-'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: require('electron'), args: [fileURLToPath(import.meta.url), '--no-sandbox', `--user-data-dir=${profile}`], env, timeout: 60000 });
    app.process().stderr.on('data', (bytes) => process.stderr.write(bytes));
    const report = { filename, scope: 'Actual Electron first visible graph after two animation frames; independent application profile, uncontrolled OS/server caches. Not GPU frame-time or cold-cache proof.', trials: [] };
    try {
        const page = await app.firstWindow();
        await page.waitForSelector('body.welcome', { timeout: 60000 });
        const consent = page.locator('#message-button');
        if (await consent.isVisible()) {
            await consent.click();
        }
        // Opens must remain serial to measure completed requests and cache reuse.
        /* eslint-disable no-await-in-loop */
        for (let trial = 0; trial < 3; trial++) {
            await page.evaluate(() => {
                globalThis.openingStarted = performance.now();
                globalThis.openingFinished = false;
                globalThis.openingSawSpinner = false;
                globalThis.openingStateObserver?.disconnect();
                globalThis.openingStateObserver = new MutationObserver(() => {
                    if (document.body.classList.contains('spinner')) {
                        globalThis.openingSawSpinner = true;
                    } else if (globalThis.openingSawSpinner && document.body.classList.contains('default')) {
                        globalThis.openingFinished = true;
                    }
                });
                globalThis.openingStateObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
                globalThis.openingLongTasks = [];
                globalThis.openingObserver?.disconnect();
                globalThis.openingObserver = new PerformanceObserver((list) => {
                    globalThis.openingLongTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })));
                });
                globalThis.openingObserver.observe({ type: 'longtask' });
            });
            await app.evaluate(({ BrowserWindow }, file) => BrowserWindow.getAllWindows()[0].webContents.send('open', { path: file }), filename);
            await page.waitForFunction(() => globalThis.openingFinished, null, { timeout: 240000 });
            await page.waitForSelector('body.default', { timeout: 240000 });
            await page.waitForSelector('#canvas .graph-node', { state: 'visible', timeout: 60000 });
            const result = await page.evaluate(async () => {
                await new Promise((resolve) => {
                    requestAnimationFrame(() => requestAnimationFrame(resolve));
                });
                globalThis.openingObserver.disconnect();
                globalThis.openingStateObserver.disconnect();
                return { visibleMs: performance.now() - globalThis.openingStarted,
                    renderedNodes: document.querySelectorAll('#canvas .graph-node').length,
                    longTasks: globalThis.openingLongTasks, devicePixelRatio };
            });
            result.trial = trial + 1;
            report.trials.push(result);
            fs.writeFileSync(output, JSON.stringify(report, null, 2));
            process.stdout.write(`${JSON.stringify(result)}\n`);
            await page.screenshot({ path: output.replace(/\.json$/, `-${trial + 1}.png`) });
        }
        /* eslint-enable no-await-in-loop */
    } finally {
        await app.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
}