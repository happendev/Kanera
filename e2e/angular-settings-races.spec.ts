import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { SocketLink } from "./support/socket";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("automation save echoes preserve newer action text and persist edits in order", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const workspaceName = uniqueName("Automation draft race");
  const created = await api.post("/api/workspaces", { data: { name: workspaceName, listNames: ["To do", "Done"], customFields: [] } });
  expect(created.ok(), await created.text()).toBe(true);
  const workspace = await created.json() as { id: string };
  const detail = await (await api.get(`/api/workspaces/${workspace.id}`)).json() as { lists: { id: string }[] };
  const ruleCreated = await api.post(`/api/workspaces/${workspace.id}/automations`, { data: {
    enabled: false,
    triggerType: "card_enters_list",
    triggerListId: detail.lists[0]!.id,
    actions: [{ type: "post_comment", config: { template: "Original comment" } }],
  } });
  expect(ruleCreated.ok(), await ruleCreated.text()).toBe(true);
  const automation = await ruleCreated.json() as { id: string };
  const firstText = "First saved sentence";
  const finalText = "First saved sentence plus newer typing";
  const socketFrames: string[] = [];
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const frame = payload.toString();
    if (frame.includes("automation:updated") && frame.includes(automation.id)) socketFrames.push(frame);
  }));
  await signIn(page, "amelia");
  await page.goto(`/w/${workspace.id}/settings/automations`);
  await page.getByRole("button", { name: "Expand automation", exact: true }).click();
  const comment = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(comment).toHaveValue("Original comment");

  const firstStarted = deferred();
  const releaseFirstRequest = deferred();
  const releaseFirstResponse = deferred();
  const requests: unknown[] = [];
  await page.route(`**/api/automations/${automation.id}/actions`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    requests.push(route.request().postDataJSON());
    if (requests.length !== 1) {
      await releaseFirstResponse.promise;
      return route.continue();
    }
    firstStarted.resolve();
    await releaseFirstRequest.promise;
    // The real server commits and broadcasts its old snapshot, while its HTTP acknowledgement
    // remains pending. This makes the socket-before-response race repeatable without fake events.
    const response = await route.fetch();
    await releaseFirstResponse.promise;
    await route.fulfill({ response });
  });
  try {
    await comment.fill(firstText);
    await firstStarted.promise;
    await comment.fill(finalText);
    releaseFirstRequest.resolve();
    await expect.poll(() => socketFrames.some((frame) => frame.includes(firstText))).toBe(true);
    await expect(comment).toHaveValue(finalText);
    releaseFirstResponse.resolve();
    await expect.poll(async () => {
      const response = await api.get(`/api/workspaces/${workspace.id}`);
      const data = await response.json() as { automations: { id: string; actions: { config: { template?: string } }[] }[] };
      return data.automations.find((rule) => rule.id === automation.id)?.actions[0]?.config.template;
    }).toBe(finalText);
    await page.reload();
    await page.getByRole("button", { name: "Expand automation", exact: true }).click();
    await expect(comment).toHaveValue(finalText);
    await page.screenshot({ path: testInfo.outputPath("automation-newer-draft-preserved.png") });
  } finally {
    releaseFirstRequest.resolve();
    releaseFirstResponse.resolve();
    await testInfo.attach("automation-save-order.json", { body: JSON.stringify({ workspaceId: workspace.id, automationId: automation.id, requests, socketFrames }, null, 2), contentType: "application/json" });
  }
});

async function selectScratchpad(page: Page, title: string) {
  await page.goto("/scratchpad");
  await page.locator(".page-trigger").click();
  await page.locator(".page-list-item").filter({ hasText: title }).click();
  await expect(page.locator(".page-trigger-label")).toHaveText(title);
  return page.locator("k-scratchpad-panel .ProseMirror");
}

async function scratchpadContent(api: APIRequestContext, id: string): Promise<string | undefined> {
  const response = await api.get("/api/scratchpad/notes");
  expect(response.ok(), await response.text()).toBe(true);
  const notes = await response.json() as { id: string; content: string }[];
  return notes.find((note) => note.id === id)?.content;
}

test("scratchpad reconnect refreshes the clean mounted editor before the next keystroke", async ({ page, signIn, pageAs, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const title = uniqueName("Scratchpad reconnect race");
  const response = await api.post("/api/scratchpad/notes", { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  const note = await response.json() as { id: string };
  const original = "Original scratchpad paragraph";
  const remote = "Updated paragraph from another device";
  expect((await api.patch(`/api/scratchpad/notes/${note.id}`, { data: { content: original } })).ok()).toBe(true);

  const link = await SocketLink.install(page.context());
  await signIn(page, "amelia");
  const editor = await selectScratchpad(page, title);
  await expect(editor).toHaveText(original);
  const otherPage = await pageAs("amelia");
  const otherEditor = await selectScratchpad(otherPage, title);
  await expect(otherEditor).toHaveText(original);
  await expect.poll(() => link.connectionCount).toBeGreaterThan(0);

  try {
    await link.cut();
    await expect.poll(() => link.refusedAttempts).toBeGreaterThan(0);
    await otherEditor.fill(remote);
    await expect.poll(() => scratchpadContent(api, note.id)).toBe(remote);
    // Prove the original tab missed the remote write before testing convergence.
    await expect(editor).toHaveText(original);
    const refreshed = page.waitForResponse((result) => result.request().method() === "GET" && result.url().endsWith("/api/scratchpad/notes"));
    link.restore();
    expect((await refreshed).ok()).toBe(true);
    await expect(editor).toHaveText(remote);
    await editor.click();
    await editor.press("Control+End");
    await page.keyboard.insertText(" and continued here");
    const expected = `${remote} and continued here`;
    await expect.poll(() => scratchpadContent(api, note.id)).toBe(expected);
    await expect(otherEditor).toHaveText(expected);
    await page.screenshot({ path: testInfo.outputPath("scratchpad-reconnect-preserves-remote-text.png") });
    await testInfo.attach("scratchpad-convergence.json", { body: JSON.stringify({ noteId: note.id, original, remote, persisted: await scratchpadContent(api, note.id), refusedAttempts: link.refusedAttempts }, null, 2), contentType: "application/json" });
  } finally {
    link.restore();
    await api.delete(`/api/scratchpad/notes/${note.id}`);
  }
});

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("Ctrl+Enter in a scratchpad page keeps the editor writable", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const title = uniqueName("Scratchpad shortcut");
  const response = await api.post("/api/scratchpad/notes", { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  const note = await response.json() as { id: string };
  await signIn(page, "amelia");
  const editor = await selectScratchpad(page, title);
  try {
    await editor.click();
    await page.keyboard.type("First thought");
    // The scratchpad autosaves and never answers an explicit save, so the shortcut must not put
    // the editor into a saving state that only a host acknowledgement could leave.
    await page.keyboard.press("Control+Enter");
    await expect(page.locator("k-scratchpad-panel .de-shell")).not.toHaveAttribute("inert", "");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await page.keyboard.type(" continued");
    await expect.poll(() => scratchpadContent(api, note.id)).toBe("First thought continued");
    await page.screenshot({ path: testInfo.outputPath("scratchpad-after-shortcut.png") });
  } finally {
    await api.delete(`/api/scratchpad/notes/${note.id}`);
  }
});

test("a foreground scratchpad refresh keeps the caret of a clean editor whose serialisation differs from the server", async ({ page, signIn, apiAs, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const title = uniqueName("Scratchpad caret");
  const response = await api.post("/api/scratchpad/notes", { data: { title } });
  expect(response.ok(), await response.text()).toBe(true);
  const note = await response.json() as { id: string };
  // Emoji shortcodes render as unicode, so the editor re-serialises this body differently from the
  // stored string although nothing changed. A refresh that compares against the live serialisation
  // rewrites the document and loses the caret on every foreground transition.
  expect((await api.patch(`/api/scratchpad/notes/${note.id}`, { data: { content: "Keep the caret :smile: here" } })).ok()).toBe(true);
  await signIn(page, "amelia");
  const editor = await selectScratchpad(page, title);
  try {
    await expect(editor).toContainText("Keep the caret");
    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowRight", { delay: 10 });
    await page.keyboard.press("ArrowRight", { delay: 10 });
    await page.keyboard.press("ArrowRight", { delay: 10 });
    await page.keyboard.press("ArrowRight", { delay: 10 });
    const refreshed = page.waitForResponse((result) => result.request().method() === "GET" && result.url().endsWith("/api/scratchpad/notes"));
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    expect((await refreshed).ok()).toBe(true);
    await page.keyboard.type("!");
    await expect(editor).toHaveText("Keep! the caret 😄 here");
    await expect.poll(() => scratchpadContent(api, note.id)).toBe("Keep! the caret 😄 here");
    await page.screenshot({ path: testInfo.outputPath("scratchpad-caret-after-refresh.png") });
  } finally {
    await api.delete(`/api/scratchpad/notes/${note.id}`);
  }
});
