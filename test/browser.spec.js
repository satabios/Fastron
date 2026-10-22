import * as fs from 'fs';
import * as path from 'path';
import * as playwright from '@playwright/test';
import * as url from 'url';
import { hierarchyModel } from './group-fixtures.mjs';

playwright.test.setTimeout(120000);

playwright.test('grouped graph keeps shapes and supports nested keyboard expansion', async ({ page }, testInfo) => {
    await page.goto('/');
    await page.waitForSelector('body.welcome');
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.open-file-button').click();
    await (await chooser).setFiles({ name: 'hierarchy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hierarchyModel())) });
    const stack = page.locator('#fold-repeated-blocks-button');
    await playwright.expect(stack).toBeEnabled();
    await stack.click();
    await playwright.expect(stack).toBeEnabled();
    await playwright.expect(stack).toHaveAttribute('aria-pressed', 'true');
    const first = page.getByRole('button', { name: 'Expand blocks.0', exact: true });
    await playwright.expect(first).toBeVisible();
    await playwright.expect(page.locator('.edge-label').filter({ hasText: 'batch×sequence_length×64' }).first()).toBeVisible();
    await first.focus();
    await first.press('Enter');
    await playwright.expect(stack).toBeEnabled();
    await playwright.expect(page.getByRole('button', { name: 'Collapse blocks.0', exact: true })).toBeVisible();
    await playwright.expect(page.getByRole('button', { name: 'Expand attn', exact: true })).toBeVisible();
    await playwright.expect(page.getByRole('button', { name: 'Expand blocks.1', exact: true })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('grouped-shapes.png'), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: testInfo.outputPath('grouped-shapes-dark.png'), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: 'Expand attn', exact: true }).click();
    await playwright.expect(stack).toBeEnabled();
    await playwright.expect(page.getByRole('button', { name: 'Collapse attn', exact: true })).toBeVisible();
    await playwright.expect(page.locator('.edge-label').filter({ hasText: 'batch×sequence_length×64' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Collapse blocks.0', exact: true }).click();
    await playwright.expect(stack).toBeEnabled();
    await playwright.expect(page.getByRole('button', { name: 'Expand blocks.0', exact: true })).toBeVisible();
    await stack.click();
    await playwright.expect(stack).toBeEnabled();
    await playwright.expect(stack).toHaveAttribute('aria-pressed', 'false');
    await playwright.expect(page.locator('.node-model-group')).toHaveCount(0);
    await playwright.expect(page.locator('.model-group')).toHaveCount(0);
});

playwright.test('browser', async ({ page }) => {

    const self = url.fileURLToPath(import.meta.url);
    const dir = path.dirname(self);
    const file = path.resolve(dir, '../third_party/test/onnx/candy.onnx');
    playwright.expect(fs.existsSync(file)).toBeTruthy();

    const startupRequests = [];
    page.on('request', (request) => startupRequests.push(new URL(request.url()).pathname));
    // Navigate to the application
    await page.goto('/');

    playwright.expect(page).toBeDefined();
    await page.waitForLoadState('domcontentloaded');

    // Wait for the welcome screen to be ready
    await page.waitForSelector('body.welcome', { timeout: 25000 });
    await page.waitForTimeout(1000);

    playwright.expect(startupRequests.some((name) => /\/(python|hdf5|flatbuffers|flexbuffers|zip|tar)\.js$/.test(name))).toBe(false);

    const consent = page.locator('#message-button');
    try {
        await consent.waitFor({ state: 'visible', timeout: 5000 });
        await consent.click();
    } catch {
        // optional consent prompt
    }

    // Set up file chooser promise before clicking
    const fileChooserPromise = page.waitForEvent('filechooser');
    const openButton = await page.locator('.open-file-button, button:has-text("Open Model")');
    await openButton.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(file);

    // Wait for the graph to render
    await page.waitForSelector('#canvas', { state: 'attached', timeout: 10000 });
    await page.waitForSelector('body.default', { timeout: 10000 });

    // Verify About panel exposes text layout diagnostics.
    const aboutMenuButton = await page.locator('#menu-button');
    await aboutMenuButton.click();
    await page.waitForTimeout(200);
    const aboutMenuItem = page.locator('button:has-text("About")').first();
    await aboutMenuItem.click();
    await page.waitForSelector('body.about', { timeout: 5000 });
    const textLayoutRow = page.locator('#text-layout-info-row');
    await playwright.expect(textLayoutRow).toBeVisible();
    const textLayoutInfoText = ((await page.locator('#text-layout-info').textContent()) || '').toLowerCase();
    playwright.expect(textLayoutInfoText).toContain('legacy');
    await page.keyboard.press('Escape');
    await page.waitForSelector('body:not(.about)', { timeout: 5000 });

    // Open find sidebar
    const menuButton = await page.locator('#menu-button');
    await menuButton.click();
    await page.waitForTimeout(200);
    const findMenuItem = await page.locator('button:has-text("Find...")');
    await findMenuItem.click();
    await page.waitForTimeout(500);
    let search = await page.waitForSelector('#search', { state: 'visible', timeout: 5000 });
    playwright.expect(search).toBeDefined();

    // Enable weights by clicking the weights toggle button and waiting for reload
    const weightsButton = await page.waitForSelector('#weights-toggle-button', { state: 'visible', timeout: 5000 });
    await weightsButton.click();
    await page.waitForSelector('body.default');
    await menuButton.click();
    await findMenuItem.click();
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

});
