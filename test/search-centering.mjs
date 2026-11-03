import { expect } from '@playwright/test';

const expectCentered = async (page, evaluate) => {
    await expect(page.locator('#canvas g.node.select')).toHaveCount(1);
    await expect.poll(() => evaluate(`(() => {
        const target = document.getElementById('target');
        const selected = target.querySelector('#canvas g.node.select');
        if (!selected) {
            return Number.MAX_VALUE;
        }
        const rect = selected.getBoundingClientRect();
        const viewport = target.getBoundingClientRect();
        const x = target.scrollLeft + rect.left + rect.width / 2 - viewport.left - target.clientWidth / 2;
        const y = target.scrollTop + rect.top + rect.height / 2 - viewport.top - target.clientHeight / 2;
        const left = Math.max(0, Math.min(x, target.scrollWidth - target.clientWidth));
        const top = Math.max(0, Math.min(y, target.scrollHeight - target.clientHeight));
        return Math.max(Math.abs(target.scrollLeft - left), Math.abs(target.scrollTop - top));
    })()`)).toBeLessThan(3);
};

export const checkSearchCentering = async (page, openFind) => {
    // The browser host disables eval, so inspect geometry through CDP.
    const session = await page.context().newCDPSession(page);
    const evaluate = async (expression) => {
        const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression, returnByValue: true });
        expect(exceptionDetails).toBeUndefined();
        return result.value;
    };
    try {
        await expect(page.locator('body')).toHaveClass(/default/);
        const stacking = page.locator('#fold-repeated-blocks-button');
        await expect(stacking).toBeEnabled();
        await stacking.click();
        await expect(stacking).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Expand blocks.1', exact: true })).toBeVisible();
        await openFind();
        const search = page.locator('#search');
        await search.fill('"/network/blocks.1/mlp/Relu"');
        const result = page.locator('.sidebar-find-content li').filter({ hasText: '/network/blocks.1/mlp/Relu' });
        await expect(result).toHaveCount(1);
        await result.click();
        await expectCentered(page, evaluate);
        // Re-click a visible node after panning within the old safe area.
        await evaluate(`document.getElementById('target').scrollBy({ top: -80, behavior: 'instant' })`);
        await result.click();
        await expectCentered(page, evaluate);
        await page.setViewportSize({ width: 960, height: 700 });
        await page.locator('#zoom-out-button').click();
        await result.click();
        await expectCentered(page, evaluate);
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.locator('#zoom-in-button').click();
        await result.dblclick();
        await expectCentered(page, evaluate);
    } finally {
        await session.detach();
    }
};
