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
});
