const { test, expect } = require('@playwright/test');
const path = require('path');

test.describe('File Loading UI Test', () => {
    let page;

    test.beforeEach(async ({ browser }) => {
        page = await browser.newPage();
        await page.goto(`file://${path.join(__dirname, '..', 'index.html')}`);
    });

    test.afterEach(async () => {
        await page.close();
    });

    test('should load example1.fit successfully', async () => {
        // Listen for any console errors
        const consoleErrors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') {
                console.errors.push(msg.text());
            }
        });

        await page.click('#btnExample1');

        // Wait for the dashboard to become visible, which indicates success
        await page.waitForSelector('#dashboard', { state: 'visible', timeout: 10000 });

        // Check that the chart canvas is present
        const chart = await page.locator('#diveChart');
        await expect(chart).toBeVisible();

        // Assert that there were no console errors during the process
        expect(consoleErrors.length).toBe(0);
    });

    test('should load example2.csv successfully', async () => {
        const consoleErrors = [];
        page.on('console', msg => {
            if (msg.type() === 'error') {
                console.errors.push(msg.text());
            }
        });

        await page.click('#btnExample2');

        await page.waitForSelector('#dashboard', { state: 'visible', timeout: 10000 });

        const chart = await page.locator('#diveChart');
        await expect(chart).toBeVisible();

        expect(consoleErrors.length).toBe(0);
    });
});
