const { test, expect } = require('@playwright/test');
const { writeFileSync } = require('node:fs');

test('table aggregates and Global Work card identity', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#email').fill('perf@kanera.local');
  await page.locator('#password').fill('Perf12345');
  await page.locator('form').evaluate(form => form.requestSubmit());
  await expect(page.locator('k-app-shell')).toBeVisible({ timeout: 90_000 });
  await page.goto('/b/70000000-0000-4000-8000-000000000200?view=table');
  await expect(page.locator('k-board-table-view .tv-cell')).not.toHaveCount(0, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const table = window.ng?.getComponent(document.querySelector('k-board-table-view'));
    return table?.cards().length === 1000 && table.customFieldValuesByCardAndField().size === 1000;
  });
  const result = await page.evaluate(() => {
    const table = window.ng.getComponent(document.querySelector('k-board-table-view'));
    const field = table.customFields().find(field => field.type === 'number');
    table.setAggregate(field.id, 'sum');
    table.setSplitBy('completion');
    const expected = table.aggregateValue(field.id);
    const samples = [];
    // Exercise the actual computed graph in a rendered Angular dev build. Rendering is timed
    // separately by the existing large-page harness; these samples isolate repeated calculations.
    for (let round = 0; round < 7; round++) {
      const start = performance.now();
      for (let i = 0; i < 200; i++) {
        table.rowRenderCap.set(100 + i);
        table.runGroups();
        if (table.aggregateValue(field.id) !== expected) throw new Error('Unstable total');
      }
      samples.push(performance.now() - start);
    }
    table.rowRenderCap.set(1000);
    table.runGroups();
    const groupKey = table.runGroups()[0].key;
    const before = table.runGroups()[0].summaries;
    table.toggleGroupCollapsed(groupKey);
    const after = table.runGroups()[0].summaries;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Collapse changed totals');
    table.toggleGroupCollapsed(groupKey);
    return { cardCount: table.cards().length, total: expected, roundsMs: samples, medianMs: [...samples].sort((a,b) => a-b)[3], summaryReferenceReused: before === after };
  });
  await expect(page.locator('k-board-table-view .tv-sum-row').first()).toBeVisible();
  // Verify an actual status picker still opens after the table updates.
  await page.locator('k-board-table-view .tv-status').first().click();
  await expect(page.locator('k-anchored-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: process.env.PERF_SCREENSHOT ?? '/tmp/kanera-table-performance.png', fullPage: false });
  await page.goto('/my-cards');
  await expect(page.locator('k-global-work')).toBeVisible();
  await page.waitForFunction(() => window.ng.getComponent(document.querySelector('k-global-work')).state.cards().length > 1);
  result.globalWork = await page.evaluate(() => {
    const state = window.ng.getComponent(document.querySelector('k-global-work')).state;
    const original = state.response();
    const initial = state.cards();
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      state.response.update(response => ({ ...response, cards: response.cards.map((card, index) => index === 0 ? { ...card, title: `Local benchmark ${i}` } : card) }));
      state.cards();
    }
    const final = state.cards();
    const result = { cardCount: initial.length, elapsedMs: performance.now() - start, unchangedReferencesReused: final.slice(1).filter((card, i) => card === initial[i + 1]).length };
    if (final[0].title !== 'Local benchmark 199') throw new Error('Card update was lost');
    state.response.set(original);
    return result;
  });
  console.log('TABLE_PERF_RESULT=' + JSON.stringify(result));
  if (process.env.PERF_OUTPUT) writeFileSync(process.env.PERF_OUTPUT, JSON.stringify(result, null, 2));
});
