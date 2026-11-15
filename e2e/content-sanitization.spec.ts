import { expect, test } from "./support/fixtures";
import { openBoard, openCard } from "./support/ui";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

async function finishLayoutTransitions(page: Page) {
  await page.evaluate(async () => {
    // A resize can start a native view transition after the layout frame. Fast-forward only
    // active finite animations; paused snapshots never resolve their finished promise.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    for (const animation of document.getAnimations()) {
      if (animation.playState === "running" && animation.playbackRate !== 0
        && Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)) animation.finish();
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

test("content submitted directly through the API cannot inject app chrome, active controls or scripts", async ({ page, apiAs, signIn, testWorkspace, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const me = await (await api.get("/api/me")).json() as { id: string };
  const createdNote = await api.post(`/api/workspaces/${testWorkspace.id}/notes`, { data: { title: uniqueName("Legacy icon"), scope: "personal" } });
  expect(createdNote.status(), await createdNote.text()).toBe(201);
  const note = await createdNote.json() as { id: string };
  const unsafeIcon = "file-text cdk-overlay-container";
  expect((await api.patch(`/api/notes/${note.id}`, { data: { icon: unsafeIcon } })).status()).toBe(400);
  expect(note.id).toMatch(/^[0-9a-f-]{36}$/);
  // Older importers could persist arbitrary icon text. Reproduce that historical
  // state only in this test-owned note, since today's HTTP boundary rejects it.
  execFileSync("docker", ["compose", "-p", "kanera-e2e", "-f", path.join(__dirname, "../docker-compose.e2e.yml"), "exec", "-T", "postgres", "psql", "-U", "kanera_test", "-d", "kanera_test_e2e", "-v", "ON_ERROR_STOP=1", "-c", `update note set icon='file-text cdk-overlay-container' where id='${note.id}'`], { encoding: "utf8", timeout: 10_000 });
  const title = uniqueName("Content boundary");
  const description = [
    '<span class="cdk-overlay-container" style="position:fixed;inset:0;z-index:2147483647;--accent:red">Overlay marker</span>',
    '<input type="password">',
    '<a href="javascript:window.__kaneraUnsafeExecuted=true">Unsafe link</a>',
    '<script>window.__kaneraUnsafeExecuted=true</script>',
    '- [x] Keep checkbox',
    `@[Amelia](kanera-user:${me.id})`,
    `[Legacy icon](/w/${testWorkspace.id}/notes?noteId=${note.id})`,
    '| Left | Right |\n| :--- | ---: |\n| Data | More |',
    '```html\n<script>literal code sample</script>\n```',
  ].join("\n\n");
  const response = await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, { data: { title, description } });
  expect(response.status(), await response.text()).toBe(201);
  await signIn(page, "amelia");
  await openBoard(page, testWorkspace.boardName);
  const detail = await openCard(page, title);
  const viewer = detail.locator("k-card-detail-description k-description-viewer");
  const marker = viewer.locator("span").filter({ hasText: /^Overlay marker$/ });
  await expect(marker).toHaveCount(1);
  await expect(marker).not.toHaveClass(/cdk-overlay-container/);
  await expect(marker).not.toHaveAttribute("style", /position|inset|z-index|--accent/);
  await expect(viewer.locator("a.internal-link-chip.is-note i")).toHaveClass("ti ti-file-text");
  await expect(viewer.locator('input[type="password"]')).toHaveCount(0);
  await expect(viewer.locator('input[type="checkbox"]')).toBeDisabled();
  await expect(viewer.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(viewer.locator("script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __kaneraUnsafeExecuted?: boolean }).__kaneraUnsafeExecuted)).toBeUndefined();
  await expect(viewer.locator("code.language-html")).toContainText("<script>literal code sample</script>");
  await expect(viewer.locator(".mention-chip")).toHaveAttribute("style", /--mention-avatar-bg/);
  await expect(viewer.locator("th").last()).toHaveCSS("text-align", "right");
  await finishLayoutTransitions(page);
  await page.screenshot({ path: testInfo.outputPath("content-sanitization-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(viewer).toBeVisible();
  await finishLayoutTransitions(page);
  await page.screenshot({ path: testInfo.outputPath("content-sanitization-phone.png"), fullPage: true, animations: "disabled" });
});
