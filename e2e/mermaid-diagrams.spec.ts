import type { APIResponse } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { openBoard, openCard } from "./support/ui";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

const flowchart = [
  "```mermaid",
  "flowchart TD",
  "    A[\"Submit request<br/>from the phone\"] --> B{\"Approved?\"}",
  "    B -- Yes --> C[\"Add permissions\"]",
  "    B -- No --> D[\"Denied\"]",
  "```",
].join("\n");
const broken = ["```mermaid", "flowchart TD", "    A -->", "```"].join("\n");

// Full-size viewers (description, notes, Markdown attachments) draw ```mermaid fences as SVG;
// compact ones (comments) keep the source. A fence that does not parse keeps its source with a note.
test("mermaid fences render as diagrams in full viewers and stay code in comments", async ({ page, apiAs, signIn, testWorkspace, uniqueName }) => {
  const api = await apiAs("amelia");
  const title = uniqueName("E2E mermaid card");
  const card = await json<{ id: string }>(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
    data: { title, description: `Flow:\n\n${flowchart}\n\nBroken:\n\n${broken}` },
  }));
  await json(await api.post(`/api/cards/${card.id}/comments`, { data: { body: `In a comment:\n\n${flowchart}` } }));
  await json(await api.post(`/api/cards/${card.id}/attachments`, {
    multipart: { file: { name: "e2e-flow.md", mimeType: "text/markdown", buffer: Buffer.from(`# Flow\n\n${flowchart}\n`) } },
  }));
  const note = await json<{ id: string }>(await api.post(`/api/workspaces/${testWorkspace.id}/notes`, {
    data: { title: uniqueName("Mermaid note"), scope: "personal" },
  }));
  await json(await api.patch(`/api/notes/${note.id}`, { data: { content: flowchart } }));

  await signIn(page, "amelia");
  await openBoard(page, testWorkspace.boardName);
  const detail = await openCard(page, title);

  const description = detail.locator("k-card-detail-description k-description-viewer");
  const diagram = description.locator(".dv-mermaid svg");
  await expect(diagram).toHaveCount(1);
  // Wrapped labels split across tspans with no space between them, so match single-line labels.
  await expect(diagram).toContainText("Approved?");
  await expect(diagram).toContainText("Denied");
  // Labels stay pure SVG so the sanitizer's SVG profile keeps them; foreignObject would be stripped.
  await expect(diagram.locator("foreignObject")).toHaveCount(0);
  await expect(description.locator("pre code.language-mermaid")).toHaveCount(1);
  await expect(description.locator(".dv-mermaid-error")).toHaveText("This diagram couldn't be drawn.");

  // Narrow layouts split Detail and Activity into tabs; wide ones show both and have no tab.
  const activityTab = detail.locator(".col-tabs").getByRole("button", { name: "Activity" });
  if (await activityTab.isVisible()) await activityTab.click();
  const comment = detail.locator(".comment").filter({ hasText: "In a comment" });
  await expect(comment.locator("pre code.language-mermaid")).toHaveCount(1);
  await expect(comment.locator(".dv-mermaid")).toHaveCount(0);

  const detailTab = detail.locator(".col-tabs").getByRole("button", { name: "Detail" });
  if (await detailTab.isVisible()) await detailTab.click();
  await detail.locator("li.attach-row").filter({ hasText: "e2e-flow.md" }).locator("a.attach-name").click();
  const lightbox = page.locator("k-image-lightbox");
  await expect(lightbox.locator(".lb-markdown .dv-mermaid svg")).toContainText("Approved?");
  await page.keyboard.press("Escape");
  await expect(lightbox).toHaveCount(0);

  await page.goto(`/w/${testWorkspace.id}/notes?noteId=${note.id}`);
  await expect(page.locator("k-note-editor .dv-mermaid svg")).toContainText("Approved?");
});

test("diagrams use the app palette across themes and scroll within phone layouts", async ({ page, apiAs, signIn, testWorkspace, uniqueName }, testInfo) => {
  const api = await apiAs("amelia");
  const title = uniqueName("Diagram styling");
  const sequence = [
    "```mermaid", "sequenceDiagram",
    "    participant Worker as Export worker", "    participant Storage as Export storage",
    "    Worker->>Storage: Write export at stable export key",
    "    Storage-->>Worker: Stored successfully",
    "    Note over Worker,Storage: Reuse stored file on retry", "```",
  ].join("\n");
  await json(await api.post(`/api/boards/${testWorkspace.boardId}/lists/${testWorkspace.lists.get("Backlog")}/cards`, {
    data: { title, description: `${flowchart}\n\n${sequence}` },
  }));
  await signIn(page, "amelia", `/b/${testWorkspace.boardId}`);
  const detail = await openCard(page, title);
  const figures = detail.locator("k-card-detail-description .dv-mermaid");
  await expect(figures).toHaveCount(2);
  const more = detail.getByRole("button", { name: "Show more", exact: true });
  if (await more.isVisible()) await more.click();

  const shape = figures.locator(".node rect").first();
  let previousFill = await shape.evaluate((element) => getComputedStyle(element).fill);
  // A theme change must invalidate cached diagrams, including when returning to the first theme.
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((nextTheme) => {
      window.dispatchEvent(new StorageEvent("storage", { key: "kanera-theme", newValue: nextTheme }));
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect.poll(() => shape.evaluate((element) => getComputedStyle(element).fill)).not.toBe(previousFill);
    previousFill = await shape.evaluate((element) => getComputedStyle(element).fill);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Large diagrams must retain readable type rather than shrinking to a fixed pixel floor.
      for (const svg of await figures.locator("svg").all()) {
        await expect.poll(() => svg.evaluate((element) => element.getBoundingClientRect().width / (element as SVGSVGElement).viewBox.baseVal.width)).toBeGreaterThanOrEqual(0.89);
      }
      const sequenceFigure = figures.nth(1);
      await sequenceFigure.scrollIntoViewIfNeeded();
      if (width === 390) {
        expect(await sequenceFigure.evaluate((element) => {
          element.scrollLeft = 50;
          return element.scrollLeft;
        })).toBeGreaterThan(0);
      }
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`), animations: "disabled" });
    }
  }
});
