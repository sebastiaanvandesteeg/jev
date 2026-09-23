import { test, expect } from '@playwright/test';

test('query Cosmos, preview, save a snapshot, and run an experiment', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Import from Cosmos DB', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Your Cosmos DB data stays unchanged');
  await expect(dialog.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Database', exact: true }).selectOption('empty');
  await expect(dialog).toContainText('No containers were found');
  await dialog.getByRole('combobox', { name: 'Database', exact: true }).selectOption('workbench');
  await dialog.getByRole('combobox', { name: 'Container', exact: true }).selectOption('messages');
  await expect(dialog.getByLabel('Maximum results')).toHaveValue('1000');
  await expect(dialog.getByLabel('Dataset name')).toHaveValue('messages snapshot');
  await dialog.getByLabel('SQL query').fill('INVALID SQL');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Cosmos DB rejected the query');
  const sql = "SELECT c.id, c.message FROM c WHERE c.id = '001'";
  await dialog.getByLabel('SQL query').fill(sql);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Query preview' })).toContainText(
    'Filtered message',
  );
  await dialog.getByLabel('Maximum results').fill('3');
  await expect(dialog.getByRole('region', { name: 'Query preview' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Query preview' })).toContainText(
    'Filtered message',
  );
  await dialog.getByLabel('Dataset name').fill('Cosmos browser snapshot');
  await page.screenshot({ path: 'test-results/cosmos-preview.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Import dataset', exact: true }).click();
  await expect(page.getByText('Reading from Cosmos DB', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A closer look at your data' })).toBeVisible();
  await expect(page.locator('table tbody tr')).toHaveCount(1);
  await expect(page.locator('table tbody')).toContainText('Filtered message');
  await page.locator('.cosmos-origin summary').click();
  await expect(page.locator('.cosmos-origin')).toContainText(sql);
  await expect(page.locator('.cosmos-origin')).toContainText('fixture.documents.azure.com');
  await page.screenshot({ path: 'test-results/cosmos-dataset.png', fullPage: true });
  await page.reload();
  await expect(page.locator('table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'New experiment', exact: true }).click();
  await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
  await expect(page.locator('.title-with-badge .badge')).toHaveText('completed');
  await expect(page.locator('.results-table tbody tr')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('unconfigured Cosmos explains setup without issuing a database request', async ({ page }) => {
  let cosmosRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/cosmos/')) cosmosRequests++;
  });
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), hasCosmosConnection: false } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import from Cosmos DB', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toContainText('COSMOS_CONNECTION_STRING');
  await expect(page.getByRole('dialog')).toContainText('Restart the backend');
  await page.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'Import dataset', exact: true }).last().click();
  await expect(page.getByLabel('Dataset file')).toBeAttached();
  expect(cosmosRequests).toBe(0);
});

test('Cosmos import dialog fits a small screen and validates limits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import from Cosmos DB', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Database', exact: true }).selectOption('workbench');
  await dialog.getByRole('combobox', { name: 'Container', exact: true }).selectOption('messages');
  await dialog.getByLabel('Maximum results').fill('10001');
  await expect(dialog.getByRole('button', { name: 'Import dataset', exact: true })).toBeDisabled();
  await dialog.getByLabel('Maximum results').fill('10');
  await expect(dialog.getByRole('button', { name: 'Import dataset', exact: true })).toBeEnabled();
  await page.screenshot({ path: 'test-results/cosmos-mobile.png', fullPage: true });
  expect(
    await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
