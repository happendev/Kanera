import type { Page } from "@playwright/test";
import { webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { createCard, openBoard, openCard } from "./support/ui";

// Deployed clients reach the public API through the web origin (nginx /public-api/ -> :3001).
const v1 = "/public-api/api/v1";

async function selectScratchpad(page: Page, title: string) {
  await page.goto("/scratchpad");
  await page.locator(".page-trigger").click();
  await page.locator(".page-list-item").filter({ hasText: title }).click();
  await expect(page.locator(".page-trigger-label")).toHaveText(title);
  return page.locator("k-scratchpad-panel .ProseMirror");
}

test("an agent's quick capture reaches the owner's open scratchpad live as a task", async ({ page, signIn, apiAs, playwright, uniqueName }) => {
  const app = await apiAs("amelia");
  const minted = await app.post("/api/me/api-keys", { data: { label: uniqueName("E2E capture key"), scope: "write" } });
  expect(minted.ok(), await minted.text()).toBe(true);
  const { secret } = await minted.json() as { secret: string };
  const pageTitle = uniqueName("Inbox");
  const created = await app.post("/api/scratchpad/notes", { data: { title: pageTitle } });
  expect(created.ok(), await created.text()).toBe(true);

  await signIn(page, "amelia");
  const editor = await selectScratchpad(page, pageTitle);

  // The public API is its own process: the page only updates if the worker drains the user-scoped
  // outbox row the capture wrote and the app API delivers it to the owner's socket.
  const agent = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  try {
    const text = uniqueName("Renew the venue insurance");
    const capture = await agent.post(`${v1}/scratchpad/capture`, { data: { text, pageTitle } });
    expect(capture.status(), await capture.text()).toBe(200);
    await expect(editor.locator('ul[data-type="taskList"] li').filter({ hasText: text })).toHaveCount(1);
    await expect(editor.locator('ul[data-type="taskList"] li').filter({ hasText: text }).locator('input[type="checkbox"]')).not.toBeChecked();
  } finally {
    await agent.dispose();
  }
});

test("a file PUT to an agent's upload link appears live in open card detail", async ({ page, signIn, apiAs, playwright, uniqueName }) => {
  const title = uniqueName("E2E upload link card");
  const app = await apiAs("amelia");
  const minted = await app.post("/api/me/api-keys", { data: { label: uniqueName("E2E upload key"), scope: "write" } });
  expect(minted.ok(), await minted.text()).toBe(true);
  const { secret } = await minted.json() as { secret: string };

  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  const created = page.waitForResponse((response) => response.request().method() === "POST" && /\/lists\/[^/]+\/cards$/.test(new URL(response.url()).pathname) && response.ok());
  await createCard(page, title);
  const { id: cardId } = await (await created).json() as { id: string };
  const detail = await openCard(page, title);

  const agent = await playwright.request.newContext({ baseURL: webOrigin, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  const uploader = await playwright.request.newContext();
  try {
    const link = await agent.post(`${v1}/cards/${cardId}/attachments/upload-links`, { data: { fileName: "e2e-run.log" } });
    expect(link.status(), await link.text()).toBe(201);
    const { uploadUrl } = await link.json() as { uploadUrl: string };

    // What `curl -T e2e-run.log <uploadUrl>` sends: a bare PUT with no bearer credential.
    const uploaded = await uploader.put(uploadUrl, { data: Buffer.from("FAILED: e2e/login.spec.ts\n"), headers: { "content-type": "application/octet-stream" } });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    await expect(detail.locator("li.attach-row").filter({ hasText: "e2e-run.log" })).toHaveCount(1);

    const reused = await uploader.put(uploadUrl, { data: Buffer.from("again") });
    expect(reused.status()).toBe(404);
  } finally {
    await agent.dispose();
    await uploader.dispose();
  }
});
