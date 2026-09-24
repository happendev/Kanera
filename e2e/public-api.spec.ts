import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { webOrigin } from "./support/env";
import { expect, test } from "./support/fixtures";
import { boardHref, openBoard, workspaceSettingsHref } from "./support/ui";

// Deployed clients reach the public API through the web origin (nginx /public-api/ -> :3001).
const v1 = "/public-api/api/v1";

type Delivery = { headers: IncomingHttpHeaders; body: string };

/** A local webhook receiver. Outside production, webhook URLs may target localhost (lib/ssrf.ts). */
async function startReceiver(): Promise<{ server: Server; url: string; deliveries: Delivery[] }> {
  const deliveries: Delivery[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      deliveries.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/kanera`, deliveries };
}

/** Reads a one-time secret from the settings page's reveal box, identified by its copy button. */
async function revealedSecret(page: Page, copyLabel: string): Promise<string> {
  const reveal = page.locator(".secret-reveal").filter({ has: page.getByRole("button", { name: copyLabel }) });
  await expect(reveal).toBeVisible();
  return (await reveal.locator("code").innerText()).trim();
}

test("a public API write reaches an open board live and a signed webhook", async ({ page, signIn, pageAs, playwright, uniqueName }) => {
  const title = uniqueName("E2E public API card");
  const receiver = await startReceiver();
  try {
    await signIn(page, "amelia");
    const boardPath = await boardHref(page, "Platform Delivery");
    const boardId = boardPath.split("/")[2]!;
    const settingsHref = await workspaceSettingsHref(page, "Platform Delivery");

    // Credentials are created the way an integrator would: once, from workspace settings.
    await page.goto(`${settingsHref}/api`);
    await page.locator('input[name="apiKeyName"]').fill(uniqueName("E2E key"));
    await page.locator('select[name="apiKeyScope"]').selectOption("write");
    await page.getByRole("button", { name: "Create API key" }).click();
    const apiKey = await revealedSecret(page, "Copy API key");
    expect(apiKey).toMatch(/^kanera_/);

    await page.locator('input[name="webhookName"]').fill(uniqueName("E2E webhook"));
    await page.locator('input[name="webhookUrl"]').fill(receiver.url);
    await page.getByRole("button", { name: "Add webhook" }).click();
    const webhookSecret = await revealedSecret(page, "Copy webhook secret");
    expect(webhookSecret).toMatch(/^whsec_/);

    const member = await pageAs("marcus");
    await openBoard(member, "Platform Delivery");

    // The public API runs as its own process. The web client only sees this write if the durable
    // outbox row is drained by the app API and fanned out to the board room.
    const publicApi = await playwright.request.newContext({
      baseURL: webOrigin,
      extraHTTPHeaders: { authorization: `Bearer ${apiKey}` },
    });
    try {
      const board = await publicApi.get(`${v1}/boards/${boardId}?includeCards=false`);
      expect(board.ok(), await board.text()).toBe(true);
      const { lists } = (await board.json()) as { lists: { id: string; name: string }[] };
      const backlog = lists.find((list) => list.name === "Backlog");
      expect(backlog, "Platform Delivery has a Backlog list").toBeDefined();

      const created = await publicApi.post(`${v1}/boards/${boardId}/lists/${backlog!.id}/cards`, { data: { title } });
      expect(created.ok(), await created.text()).toBe(true);
      const card = (await created.json()) as { id: string };

      await expect(member.locator("k-list").filter({ hasText: "Backlog" }).locator("k-card").filter({ hasText: title })).toHaveCount(1);

      // Webhook delivery is scheduled by the worker process from the same outbox row.
      await expect.poll(() => receiver.deliveries.find((d) => d.body.includes(card.id) && d.body.includes('"card:created"')), { timeout: 30_000 }).toBeTruthy();
      const delivery = receiver.deliveries.find((d) => d.body.includes(card.id) && d.body.includes('"card:created"'))!;
      const timestamp = String(delivery.headers["x-kanera-timestamp"]);
      const expected = `sha256=${createHmac("sha256", webhookSecret).update(`${timestamp}.${delivery.body}`).digest("hex")}`;
      expect(delivery.headers["x-kanera-signature"]).toBe(expected);
      const event = JSON.parse(delivery.body) as { type: string; boardId?: string; cardId?: string };
      expect(event).toMatchObject({ type: "card:created", boardId, cardId: card.id });
    } finally {
      await publicApi.dispose();
    }
  } finally {
    receiver.server.close();
  }
});
