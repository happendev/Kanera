import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "./support/fixtures";
import { expectBoardLoaded } from "./support/ui";

const run = promisify(execFile);

// Exercise billing's transaction/deferred-publication boundary in another process using real Valkey
// and the real event outbox. Provider timing and payment failures live in billing/reliability.itest.ts.
async function convert(clientId: string, paid: boolean, rollback = false) {
  const code = `
    (async () => {
      const url = new URL(process.env.DATABASE_URL);
      if (url.hostname !== 'localhost' || url.port !== '55434' || url.pathname !== '/kanera_test_e2e') throw new Error('Refusing non-E2E database');
      const { db, pool } = await import('./src/db.ts');
      const { env } = await import('./src/env.ts');
      const { initRedis, closeRedis } = await import('./src/redis.ts');
      const { convertClientPlan } = await import('./src/lib/plan-conversion.ts');
      const effects = [];
      try {
        await initRedis();
        try {
          await db.transaction(async tx => {
            await convertClientPlan(${JSON.stringify(clientId)}, ${JSON.stringify(paid ? { plan: "paid", billingStatus: "active" } : { plan: "free", billingStatus: "canceled" })}, tx,
              { ...env, KANERA_DEPLOYMENT_MODE: 'hosted', HOSTED_FREE_MAX_BOARDS: 1 }, publish => effects.push(publish));
            if (${rollback}) throw new Error('expected rollback');
          });
        } catch (error) {
          if (!${rollback} || error.message !== 'expected rollback') throw error;
        }
        if (!${rollback}) for (const publish of effects) await publish();
      } finally { await closeRedis(); await pool.end(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await run("pnpm", ["--dir", "apps/api", "exec", "tsx", "--eval", code], { timeout: 30_000 });
}

test("billing conversions publish board changes only after commit and restore them across processes", async ({ page, uniqueName }, testInfo) => {
  const name = uniqueName("Billing realtime");
  const signup = await page.request.post("/api/auth/signup", { data: { orgName: name, email: `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}@example.test`, displayName: "Billing Owner", password: "Abc12345" } });
  expect(signup.status()).toBe(200);
  const account = await signup.json() as { accessToken: string; user: { clientId: string } };
  const headers = { authorization: `Bearer ${account.accessToken}` };
  try {
    const workspace = await page.request.post("/api/workspaces", { headers, data: { name, initialBoard: { name: "Retained board" } } });
    expect(workspace.ok()).toBe(true);
    const ws = await workspace.json() as { id: string };
    const added = await page.request.post(`/api/workspaces/${ws.id}/boards`, { headers, data: { name: "Restored billing board" } });
    expect(added.ok()).toBe(true);
    const board = await added.json() as { id: string };
    const deletions: string[] = [];
    page.on("websocket", socket => socket.on("framereceived", frame => {
      const payload = String(frame.payload);
      if (payload.includes("board:deleted") && payload.includes(board.id)) deletions.push(payload);
    }));
    await page.goto("/");
    const link = page.locator("a.board-link").filter({ hasText: "Restored billing board" });
    await expect(link).toBeVisible();

    await convert(account.user.clientId, false, true);
    // A rolled-back conversion must not remove a board from another process's live sidebar.
    await page.waitForTimeout(2_000);
    expect(deletions).toHaveLength(0);
    await expect(link).toBeVisible();

    await convert(account.user.clientId, false);
    await expect(link).toHaveAttribute("aria-disabled", "true");
    expect(deletions.length).toBeGreaterThan(0);
    await convert(account.user.clientId, true);
    await expect(link).toHaveAttribute("href", `/b/${board.id}`);
    await expect(link).not.toHaveAttribute("aria-disabled", "true");
    await link.click();
    await expectBoardLoaded(page, "Restored billing board");
    await page.screenshot({ path: testInfo.outputPath("billing-restored-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("billing-restored-phone.png"), fullPage: true });
  } finally {
    const removed = await page.request.delete("/api/clients/me", { headers, data: { confirmationName: name } });
    expect(removed.ok()).toBe(true);
  }
});
