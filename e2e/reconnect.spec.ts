import { expect, test } from "./support/fixtures";
import { SocketLink } from "./support/socket";
import { cardTile, createCard, expectBoardLoaded, openBoard, openCard } from "./support/ui";

test("a disconnected board converges on the latest card after its socket reconnects", async ({ page, signIn, pageAs, uniqueName }) => {
  const original = uniqueName("E2E reconnect card");
  const updated = `${original} updated`;
  let link!: SocketLink;
  await signIn(page, "amelia");
  const second = await pageAs("marcus", {
    beforeSignIn: async (context) => {
      link = await SocketLink.install(context);
    },
  });
  await openBoard(page, "Platform Delivery");
  await openBoard(second, "Platform Delivery");

  await createCard(page, original);
  await expect(cardTile(second, original)).toHaveCount(1);

  await link.cut();
  // Proves the cut is real: the client noticed and its reconnect attempts are being refused.
  await expect.poll(() => link.refusedAttempts).toBeGreaterThan(0);

  const detail = await openCard(page, original);
  await detail.locator("h2.card-title").click();
  await detail.locator("input.title-input").fill(updated);
  await detail.locator("input.title-input").press("Enter");
  await expect(page.getByRole("dialog", { name: `Card detail: ${updated}` })).toBeVisible();
  // Bounded negative check: live delivery normally lands well inside this window, so seeing the
  // rename here would mean the cut leaked and the rest of the test proves nothing.
  await second.waitForTimeout(3_000);
  await expect(cardTile(second, updated)).toHaveCount(0);

  link.restore();
  // The server does not enable Socket.IO connection-state recovery, so the missed card:updated is
  // gone; the board converges only if it resyncs after rejoining its room (board:join -> onJoined).
  await expect(cardTile(second, updated)).toHaveCount(1);
  await expect(cardTile(second, original).filter({ hasNotText: "updated" })).toHaveCount(0);
  await second.reload();
  await expectBoardLoaded(second, "Platform Delivery");
  await expect(cardTile(second, updated)).toHaveCount(1);
});
