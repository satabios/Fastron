
import * as fs from 'fs';
import * as path from 'path';
import * as playwright from '@playwright/test';
import * as url from 'url';

playwright.test.setTimeout(120000);

playwright.test('desktop', async () => {

    const self = url.fileURLToPath(import.meta.url);
    const dir = path.dirname(self);
    const file = path.resolve(dir, '../third_party/test/onnx/candy.onnx');
    playwright.expect(fs.existsSync(file)).toBeTruthy();

    // Launch app
    const electron = await playwright._electron;
    const args = ['.', '--no-sandbox'];
    const app = await electron.launch({ args });
    const page = await app.firstWindow();

    playwright.expect(page).toBeDefined();
    await page.waitForLoadState('load');
    await page.waitForSelector('body.welcome', { state: 'attached', timeout: 30000 });
    await page.waitForTimeout(1000);

    const consent = await page.locator('#message-button');
    if (await consent.isVisible({ timeout: 25000 })) {
        await consent.click();
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
    await page.waitForSelector('#canvas', { state: 'attached', timeout: 10000 });
    await page.waitForSelector('body.default', { timeout: 10000 });

    // Open find sidebar
    await app.evaluate(async (electron) => {
        const windows = electron.BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const [window] = windows;
            window.webContents.send('find', {});
        }
    });
    await page.waitForTimeout(500);
    const search = await page.waitForSelector('#search', { state: 'visible', timeout: 5000 });
    playwright.expect(search).toBeDefined();

    // Enable weights by clicking the weights toggle button and waiting for reload
    const weightsButton = await page.waitForSelector('#weights-toggle-button', { state: 'visible', timeout: 5000 });
    await weightsButton.click();
    await page.waitForTimeout(2000); // Wait for model to reload with weights

    // Find and activate tensor
    await search.fill('convolution1_W');
    await page.waitForSelector('.sidebar-find-content li', { state: 'attached' });
    const item = await page.waitForSelector('.sidebar-find-content li:has-text("convolution1_W")');
    await item.dblclick();

    // Expand the 'value' field
    const valueEntry = await page.waitForSelector('#sidebar-content .sidebar-item:has(.sidebar-item-name input[value="value"])');
    const valueButton = await valueEntry.waitForSelector('.sidebar-item-value-button');
    await valueButton.click();

    // Check first number from tensor value — wait for async weight materialization
    const pre = await valueEntry.waitForSelector('pre');
    let text = '';
    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < 50; i++) {
        text = (await pre.textContent()) || '';
        if (/\d+\.\d+/.test(text)) {
            break;
        }
        await page.waitForTimeout(200);
    }
    /* eslint-enable no-await-in-loop */
    const match = text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
    playwright.expect(match).not.toBeNull();
    const first = parseFloat(match[0]);
    playwright.expect(first).toBe(0.1353299617767334);

    await app.close();
});
