const { test, expect } = require('@playwright/test');

// Writes only to the marked local performance board. Re-seed before comparative benchmarks.
test('cross-list drop, matched preview, cursor cleanup and Escape cancellation', async ({ page }) => {
  if (!['localhost', '127.0.0.1'].includes(new URL(test.info().project.use.baseURL).hostname)) throw new Error('This mutation check requires the local benchmark fixture');
  await page.goto('/login');
  await page.locator('#email').fill('perf@kanera.local');
  await page.locator('#password').fill('Perf12345');
  await page.locator('form').evaluate(form => form.requestSubmit());
  await expect(page.locator('k-app-shell')).toBeVisible({ timeout: 90_000 });
  await page.goto('/b/70000000-0000-4000-8000-000000000200?view=board');
  const lists = page.locator('k-board k-list');
  await expect(lists).toHaveCount(8);
  const sourceList = lists.nth(0);
  const targetList = lists.nth(1);
  const source = sourceList.locator('k-card').first();
  await expect(source).toBeVisible();
  const moving = await source.evaluate(el => {
    const card = window.ng.getComponent(el).card();
    return { id: card.id, title: card.title };
  });
  const targetId = await targetList.getAttribute('data-list-id');
  const before = await source.boundingBox();
  const destination = await targetList.locator('k-card').first().boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + 40);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 12, before.y + 52);
  const preview = page.locator('.cdk-drag-preview');
  await expect(preview).toBeVisible();
  const geometry = await preview.boundingBox();
  expect(Math.abs(geometry.width - before.width)).toBeLessThan(2);
  expect(Math.abs(geometry.height - before.height)).toBeLessThan(2);
  const point = { x: destination.x + destination.width / 2, y: destination.y + 50 };
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await expect.poll(() => page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor, point)).toBe('grabbing');
  const response = page.waitForResponse(response => response.url().includes(`/cards/${moving.id}/move`) && response.request().method() === 'POST');
  await page.mouse.up();
  expect((await response).status()).toBe(200);
  await expect(preview).toHaveCount(0);
  await expect.poll(() => page.evaluate(id => window.ng.getComponent(document.querySelector('k-board-page')).state.cardById(id)?.listId, moving.id)).toBe(targetId);
  const moved = targetList.locator('k-card').filter({ hasText: moving.title });
  await expect(moved).toBeVisible();
  await expect(page.locator('[style*="cursor: grabbing"]')).toHaveCount(0);

  let additionalMoves = 0;
  page.on('request', request => { if (request.url().includes(`/cards/${moving.id}/move`) && request.method() === 'POST') additionalMoves++; });
  const box = await moved.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + 52);
  await expect(preview).toBeVisible();
  await page.mouse.move(before.x + before.width / 2, before.y + 50, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  expect(additionalMoves).toBe(0);
  await expect(moved).toBeVisible();
  await expect(page.locator('[style*="cursor: grabbing"]')).toHaveCount(0);

  await moved.hover();
  await moved.locator('.card-actions-btn').click();
  const menu = page.locator('k-card-actions-menu');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 20));
  })).toBe(true);
  await page.screenshot({ path: '/tmp/kanera-notes-interactions.png', fullPage: false });
  await page.keyboard.press('Escape');
});
