
import * as fs from 'fs';
import * as path from 'path';
import * as playwright from '@playwright/test';
import * as url from 'url';
import { writeRepeatedModel } from './repeated-fixtures.mjs';

playwright.test.setTimeout(120000);

const createProfile = (directory) => {
    fs.mkdirSync(directory, { recursive: true });
    // Graph tests must not wait for geolocation or a delayed consent dialog.
    // The isolated profile never changes a user's normal application settings.
    fs.writeFileSync(path.join(directory, 'configuration.json'), JSON.stringify({ consent: Date.now(), recents: [] }));
    return directory;
};

playwright.test('desktop', async ({ playwright: driver }, testInfo) => {

    const self = url.fileURLToPath(import.meta.url);
    const dir = path.dirname(self);
    const file = path.resolve(dir, '../third_party/test/onnx/candy.onnx');
    playwright.expect(fs.existsSync(file)).toBeTruthy();

    // Launch app
    const electron = driver._electron;
    const profile = createProfile(testInfo.outputPath('profile'));
    const args = ['.', '--no-sandbox', `--user-data-dir=${profile}`];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args, env });
    try {
        const page = await app.firstWindow();

        playwright.expect(page).toBeDefined();
        await page.waitForLoadState('load');
        await page.waitForSelector('body.welcome', { state: 'attached', timeout: 30000 });
        await page.waitForTimeout(1000);

        const consent = page.locator('#message-button');
        try {
            await consent.waitFor({ state: 'visible', timeout: 5000 });
            await consent.click();
        } catch {
            // optional consent prompt
        }

        // Open the model
        await app.evaluate(async (electron, location) => {
            const windows = electron.BrowserWindow.getAllWindows();
            if (windows.length > 0) {
                const [window] = windows;
                window.webContents.send('open', { path: location });
            }
        }, file);

        // Wait for the graph to render
        try {
            await page.waitForSelector('#canvas', { state: 'attached', timeout: 10000 });
        } catch (error) {
            throw new Error(`${error.message}\nRenderer message: ${await page.locator('#message-text').innerText()}`);
        }
        await page.waitForSelector('body.default', { timeout: 10000 });

        // Verify About panel exposes text layout diagnostics.
        await app.evaluate(async (electron) => {
            const windows = electron.BrowserWindow.getAllWindows();
            if (windows.length > 0) {
                windows[0].webContents.send('about', {});
            }
        });
        await page.waitForSelector('body.about', { timeout: 5000 });
        const textLayoutRow = page.locator('#text-layout-info-row');
        await playwright.expect(textLayoutRow).toBeVisible();
        const textLayoutInfoText = ((await page.locator('#text-layout-info').textContent()) || '').toLowerCase();
        playwright.expect(textLayoutInfoText).toContain('legacy');
        await page.keyboard.press('Escape');
        await page.waitForSelector('body:not(.about)', { timeout: 5000 });

        // Open find sidebar
        await app.evaluate(async (electron) => {
            const windows = electron.BrowserWindow.getAllWindows();
            if (windows.length > 0) {
                const [window] = windows;
                window.webContents.send('find', {});
            }
        });
        await page.waitForTimeout(500);
        let search = await page.waitForSelector('#search', { state: 'visible', timeout: 5000 });
        playwright.expect(search).toBeDefined();

        // Enable weights by clicking the weights toggle button and waiting for reload
        const weightsButton = await page.waitForSelector('#weights-toggle-button', { state: 'visible', timeout: 5000 });
        await weightsButton.click();
        await page.waitForSelector('body.default');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('find', {}));
        search = await page.waitForSelector('#search', { state: 'visible' });

        // Find and activate tensor
        await search.fill('convolution1_W');
        await page.waitForSelector('.sidebar-find-content li', { state: 'attached' });
        const firstResult = page.locator('.sidebar-find-content li').first();
        const textEngine = await firstResult.getAttribute('data-text-engine');
        playwright.expect(['legacy', 'shadow', 'pretext']).toContain(textEngine);
        const textWidth = await firstResult.getAttribute('data-text-width');
        playwright.expect(Number(textWidth)).toBeGreaterThan(0);
        const item = await page.waitForSelector('.sidebar-find-content li:has-text("convolution1_W")');
        await item.dblclick();

        // Expand the 'value' field
        const valueEntry = await page.waitForSelector('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"])');
        const valueButton = await valueEntry.waitForSelector('.sidebar-item-value-button');
        await valueButton.click();

        // Locate the rendered preview, which replaces the asynchronous loading placeholder.
        await playwright.expect(page.locator('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"]) pre').last()).toContainText('0.1353299617767334');

    } finally {
        await app.close();
    }
});

playwright.test('comparator detects rewiring in real model files', async ({ playwright: driver }, testInfo) => {
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const graph = {
        name: 'comparison',
        node: [
            { name: 'left', opType: 'Relu', input: ['x'], output: ['left:0'] },
            { name: 'right', opType: 'Relu', input: ['x'], output: ['right:0'] },
            { name: 'sink', opType: 'Relu', input: ['left:0'], output: ['y'] }
        ],
        input: [{ name: 'x', type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: '2' }] } } } }],
        output: [{ name: 'y', type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: '2' }] } } } }]
    };
    const a = testInfo.outputPath('a.onnx');
    const b = testInfo.outputPath('b.onnx');
    fs.mkdirSync(path.dirname(a), { recursive: true });
    const model = { irVersion: '8', opsetImport: [{ domain: '', version: '13' }], graph };
    fs.writeFileSync(a, JSON.stringify(model));
    graph.node[2].input = ['right:0'];
    fs.writeFileSync(b, JSON.stringify(model));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await driver._electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${testInfo.outputPath('profile')}`], env });
    try {
        await app.firstWindow();
        const pathname = path.resolve(dir, '../source/comparator.html');
        const windowPromise = app.waitForEvent('window');
        await app.evaluate(async ({ BrowserWindow }, options) => {
            const window = new BrowserWindow({ width: 1200, height: 800, webPreferences: {
                preload: options.preload, contextIsolation: true, nodeIntegration: true
            } });
            window.webContents.once('did-finish-load', () => {
                window.webContents.send('compare', { pathA: { path: options.a, label: 'a.onnx' }, pathB: { path: options.b, label: 'b.onnx' } });
            });
            await window.loadURL(options.data, { baseURLForDataURL: options.baseURL });
        }, {
            preload: path.resolve(dir, '../source/desktop.mjs'),
            data: `data:text/html;charset=utf-8,${encodeURIComponent(fs.readFileSync(pathname, 'utf8'))}`,
            baseURL: url.pathToFileURL(pathname).toString(), a, b
        });
        const page = await windowPromise;
        playwright.expect(page).toBeDefined();
        await page.waitForLoadState('load');
        try {
            await playwright.expect(page.locator('#diff-summary')).toContainText('1 modified', { timeout: 30000 });
        } catch (error) {
            throw new Error(`${error.message}\nComparator: ${await page.locator('.spinner-text').innerText()}`);
        }
        await playwright.expect(page.locator('#diff-summary')).toContainText('2 same structure');
        await playwright.expect(page.locator('#diff-summary')).not.toContainText('Matching…');
        await playwright.expect(page.locator('#diff-summary')).toContainText('weight values are not compared');
        await playwright.expect(page.locator('#target-left svg')).toBeVisible();
        await playwright.expect(page.locator('#target-right svg')).toBeVisible();
        await page.locator('#target-left .node-diff-modified text').filter({ hasText: 'Relu' }).first().click();
        await playwright.expect(page.locator('#diff-panel-content')).toContainText('Inputs');
        await playwright.expect(page.locator('#diff-panel-content')).not.toContainText('Same structure');
    } finally {
        await app.close();
    }
});

playwright.test('desktop folds repeated blocks and reveals the actual hidden weights', async ({ playwright: driver }, testInfo) => {
    const folder = testInfo.outputPath('repeated');
    fs.mkdirSync(folder, { recursive: true });
    const { file } = writeRepeatedModel(folder, 'safetensors');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const profile = createProfile(path.join(folder, 'profile'));
    const app = await driver._electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${profile}`], env });
    try {
        const page = await app.firstWindow();
        await page.waitForSelector('body.welcome', { timeout: 30000 });
        const consent = page.locator('#message-button');
        if (await consent.isVisible()) {
            await consent.click();
        }
        await app.evaluate(({ BrowserWindow }, file) => {
            BrowserWindow.getAllWindows()[0].webContents.send('open', { path: file });
        }, file);
        const nodes = page.locator('#canvas .graph-node');
        await playwright.expect(nodes).toHaveCount(48, { timeout: 30000 });
        await page.waitForSelector('body.default');
        await playwright.expect(page.locator('.node-item-repeat')).toHaveCount(0);
        if (process.platform === 'darwin') {
            // Background test sessions may not grant OS focus; dispatch the native window event.
            await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
            await playwright.expect.poll(() => app.evaluate(({ Menu }) => {
                const item = Menu.getApplicationMenu().getMenuItemById('view.toggle-repeated-blocks');
                return { present: Boolean(item), enabled: item?.enabled, label: item?.label };
            })).toMatchObject({ present: true, enabled: true, label: playwright.expect.stringContaining('Group') });
            await app.evaluate(({ Menu }) => {
                const item = Menu.getApplicationMenu().getMenuItemById('view.toggle-repeated-blocks');
                item.click();
            });
        } else {
            await page.locator('#menu-button').click();
            await page.locator('button:has-text("Group Model")').first().click();
        }
        await playwright.expect(nodes).toHaveCount(2, { timeout: 30000 });
        const stacking = page.getByRole('button', { name: 'Graph Stacking', exact: true });
        await playwright.expect(stacking).toHaveAttribute('aria-pressed', 'true');
        await stacking.click();
        await playwright.expect(nodes).toHaveCount(48);
        await playwright.expect(stacking).toHaveAttribute('aria-pressed', 'false');
        await stacking.click();
        await playwright.expect(nodes).toHaveCount(2);
        if (process.platform === 'darwin') {
            await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
            await playwright.expect.poll(() => app.evaluate(({ Menu }) =>
                Menu.getApplicationMenu().getMenuItemById('view.toggle-repeated-blocks').label
            )).toContain('Ungrouped');
        }
        await page.locator('.node-item-repeat').click();
        await page.getByLabel('Representative layer').selectOption('17');
        await playwright.expect(page.getByLabel('Representative layer')).toHaveValue('17');
        await playwright.expect(stacking).toBeEnabled();
        const sidebar = page.locator('#sidebar-content');
        await sidebar.getByText('Expand stack', { exact: true }).click();
        await playwright.expect(stacking).toBeEnabled();
        await playwright.expect(nodes).toHaveCount(48);
        await sidebar.getByText('Fold stack', { exact: true }).click();
        await playwright.expect(stacking).toBeEnabled();
        await playwright.expect(nodes).toHaveCount(2);
        await playwright.expect(sidebar.getByText('Expand stack', { exact: true })).toBeVisible();
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('find', {}));
        await page.locator('#search').fill('encoder.layers.7.q_proj.weight');
        await page.locator('.sidebar-find-content li').filter({ hasText: 'encoder.layers.7.q_proj.weight' }).dblclick();
        const entry = page.locator('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"])');
        await entry.locator('.sidebar-item-value-button').first().click();
        await entry.locator('pre').click();
        await playwright.expect(entry.locator('pre').last()).toContainText('70');
    } finally {
        await app.close();
    }
});
