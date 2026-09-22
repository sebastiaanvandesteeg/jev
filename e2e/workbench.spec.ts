import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('upload, inspect, experiment, filter, export and reuse history in the browser', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dataset library' })).toBeVisible();
  await page.screenshot({ path: 'test-results/library.png', fullPage: true });
  await page.getByRole('button', { name: 'Import dataset', exact: true }).last().click();
  await page.getByLabel('Dataset file').setInputFiles(path.resolve('examples/exploration.zip'));
  await page.getByLabel('Dataset name').fill('Browser exploration');
  await page.getByRole('dialog').getByRole('button', { name: 'Import dataset' }).click();
  await expect(
    page.getByRole('heading', { name: 'Browser exploration', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A closer look at your data' })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator('table tbody tr')).toHaveCount(15);
  await page.screenshot({ path: 'test-results/dataset.png', fullPage: true });
  await page.locator('table tbody tr').filter({ hasText: 'messages.json' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('customer');
  await page.getByLabel('Close dialog').click();
  await page.getByRole('button', { name: 'New experiment', exact: true }).click();
  await page.getByRole('button', { name: /Detect a condition/ }).click();
  await page.getByRole('button', { name: /Rank by relevance/ }).click();
  await page.getByLabel('Shared reference context').fill('Account access problems');
  await expect(page.getByRole('button', { name: 'Preview a request' })).toBeEnabled();
  await page.getByRole('button', { name: 'Preview a request' }).click();
  await expect(page.getByRole('dialog')).toContainText('needs_attention');
  await expect(page.getByRole('dialog')).toContainText('Account access problems');
  await page.getByLabel('Close dialog').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/experiment.png', fullPage: true });
  await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
  await expect(page.locator('.title-with-badge .badge')).toHaveText('completed', {
    timeout: 15000,
  });
  await expect(page.locator('.results-table tbody tr')).toHaveCount(10);
  await page.screenshot({ path: 'test-results/results.png', fullPage: true });
  await page.getByLabel('Sort and filter by question').selectOption('needs_attention');
  await page.getByLabel('Minimum value').fill('0.9');
  await expect(page.getByText('No results match these filters.')).toBeVisible();
  await page.getByLabel('Minimum value').fill('0.5');
  await expect(page.locator('.results-table tbody tr')).toHaveCount(10);
  await page.locator('.results-table tbody tr').first().click();
  await expect(page.getByRole('dialog')).toContainText('jev-test-pinned');
  await expect(page.getByRole('heading', { name: 'Exact input request' })).toBeVisible();
  await page.getByLabel('Close dialog').click();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'JSON', exact: true }).click();
  const downloaded = await download;
  const exported = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
  expect(exported.results).toHaveLength(10);
  await page.reload();
  await expect(page.locator('.results-table tbody tr')).toHaveCount(10);
  await page.getByRole('button', { name: 'All runs', exact: true }).click();
  await expect(page.locator('.history-table tbody tr')).toHaveCount(1);
  await page.locator('.history-table tbody tr').first().click();
  await page.getByRole('button', { name: 'Use this configuration again' }).click();
  await expect(page.getByLabel('Experiment name')).toHaveValue('My first experiment · next run');
  await expect(page.getByLabel('Shared reference context')).toHaveValue('Account access problems');
  await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
  await expect(page.locator('.title-with-badge .badge')).toHaveText('completed', {
    timeout: 15000,
  });
  expect(errors).toEqual([]);
});

test('small viewport keeps import and navigation usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dataset library' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Import dataset', exact: true }).last(),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});

for (const format of ['json', 'csv'] as const) {
  test(`upload ${format.toUpperCase()} directly and run an experiment`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Import dataset', exact: true }).last().click();
    await page.getByLabel('Dataset file').setInputFiles({
      name: `direct-${format}.${format}`,
      mimeType: format === 'json' ? 'application/json' : 'text/csv',
      buffer: Buffer.from(
        format === 'json'
          ? '{"Documents":[{"id":"001","message":"Please help"},{"id":"002","message":"All done"}]}'
          : 'id,message\n001,"Please help"\n002,"All done"\n',
      ),
    });
    await expect(page.getByLabel('Dataset name')).toHaveValue(`direct-${format}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Import dataset' }).click();
    if (format === 'json') {
      await expect(page.getByRole('heading', { name: 'Where are your records?' })).toBeVisible();
      await page.getByLabel('Records in direct-json.json').selectOption('/Documents');
      await page.getByRole('button', { name: 'Continue import' }).click();
    }
    await expect(page.getByRole('heading', { name: 'A closer look at your data' })).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(2);
    await expect(page.locator('table tbody tr').first()).toContainText('001');
    await page.getByRole('button', { name: 'New experiment', exact: true }).click();
    await page.getByRole('button', { name: 'Run experiment', exact: true }).click();
    await expect(page.locator('.title-with-badge .badge')).toHaveText('completed', {
      timeout: 15000,
    });
    await expect(page.locator('.results-table tbody tr')).toHaveCount(2);
  });
}
