import { test, expect } from '@playwright/test';

test('rename from the dataset and library, retain history, then confirm deletion', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Import dataset', exact: true }).last().click();
  await page.getByLabel('Dataset file').setInputFiles({
    name: 'manage-dataset.json',
    mimeType: 'application/json',
    buffer: Buffer.from('[{"id":"001","message":"Please help"},{"id":"002","message":"Done"}]'),
  });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import dataset', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'A closer look at your data' })).toBeVisible();
  const datasetId = new URL(page.url()).hash.split('/')[2];
  await page.getByRole('button', { name: 'New experiment', exact: true }).click();
  await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
  await expect(page.locator('.title-with-badge .badge')).toHaveText('completed');
  const runId = new URL(page.url()).hash.split('/')[4];
  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Rename dataset', exact: true }).click();
  await expect(dialog.getByLabel('Dataset name')).toHaveValue('manage-dataset');
  await expect(dialog.getByLabel('Dataset name')).toBeFocused();
  await dialog.getByLabel('Dataset name').fill('   ');
  await expect(dialog.getByRole('button', { name: 'Save name' })).toBeDisabled();
  await dialog.getByLabel('Dataset name').fill('  Customer messages  ');
  await dialog.getByRole('button', { name: 'Save name' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Customer messages', exact: true })).toBeVisible();
  await expect(page.locator('.current-crumb')).toHaveText('Customer messages');
  await expect(page.locator('.results-table tbody tr')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Customer messages', exact: true })).toBeVisible();
  await expect(page.locator('.results-table tbody tr')).toHaveCount(2);
  await page.getByRole('link', { name: 'Datasets', exact: true }).click();
  const card = page
    .locator('.dataset-card')
    .filter({ has: page.getByRole('heading', { name: 'Customer messages', exact: true }) });
  await card.getByRole('button', { name: 'Rename dataset Customer messages', exact: true }).click();
  await dialog.getByLabel('Dataset name').fill('Discarded name');
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Rename dataset Customer messages', exact: true }).click();
  await dialog.getByLabel('Dataset name').fill('Renamed from library');
  await dialog.getByRole('button', { name: 'Save name' }).click();
  await expect(
    page.getByRole('heading', { name: 'Renamed from library', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.sidebar-datasets')).toContainText('Renamed from library');
  await page.screenshot({ path: 'test-results/dataset-actions-library.png', fullPage: true });
  await page
    .getByRole('button', { name: 'Open dataset Renamed from library', exact: true })
    .click();
  await expect(page.locator('table tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  await expect(dialog).toContainText('Renamed from library');
  await expect(dialog).toContainText('experiment history');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('heading', { name: 'Renamed from library', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  await page.screenshot({ path: 'test-results/dataset-delete-dialog.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dataset library' })).toBeVisible();
  await expect(page.locator('.sidebar-datasets')).not.toContainText('Renamed from library');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dataset library' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Renamed from library', exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get(`/api/datasets/${datasetId}`)).status()).toBe(404);
  expect((await page.request.get(`/api/runs/${runId}`)).status()).toBe(404);
  expect(errors).toEqual([]);
});

test('delete a Cosmos snapshot from its library card with a recoverable error', async ({
  page,
}) => {
  const imported = await page.request.post('/api/cosmos/import', {
    data: {
      name: 'Disposable Azure snapshot',
      databaseId: 'workbench',
      containerId: 'messages',
      query: 'SELECT * FROM c',
      limit: 10,
    },
  });
  expect(imported.status()).toBe(202);
  const { id } = await imported.json();
  await expect
    .poll(async () => (await (await page.request.get(`/api/datasets/${id}`)).json()).status)
    .toBe('ready');
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Delete dataset Disposable Azure snapshot', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Your Azure Cosmos DB source data is unchanged.');
  await page.route(`**/api/datasets/${id}`, async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({
        status: 409,
        json: { error: 'An experiment is still active. Wait for it to finish.' },
      });
    } else await route.fallback();
  });
  await dialog.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('An experiment is still active');
  expect((await page.request.get(`/api/datasets/${id}`)).status()).toBe(200);
  await page.unroute(`**/api/datasets/${id}`);
  await dialog.getByRole('button', { name: 'Delete dataset', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Disposable Azure snapshot', exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get(`/api/datasets/${id}`)).status()).toBe(404);
});
