import { readFileSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Locator } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { createCard, openBoard, openCard } from "./support/ui";

// Phone-sized touch device. The app's viewport meta disables browser zoom, so the lightbox's own
// gestures are the only way to zoom an attachment on a phone.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const image = readFileSync(path.join(__dirname, "..", "dev-db-seed-content", "attachments", "images", "access-review-symbol.png"));

type Point = { x: number; y: number };

/** Real multi-touch through CDP: Playwright's touchscreen API only supports single taps. */
async function pinch(cdp: CDPSession, from: [Point, Point], to: [Point, Point], steps = 8) {
  const points = (a: Point, b: Point) => [{ id: 1, ...a }, { id: 2, ...b }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(...from) });
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const lerp = (a: Point, b: Point) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points(lerp(from[0], to[0]), lerp(from[1], to[1])),
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function zoomPercent(lightbox: Locator): Promise<number> {
  return parseInt((await lightbox.locator(".lb-zoom-pct").textContent()) ?? "", 10);
}

test("lightbox images pinch-zoom and double-tap-zoom on a phone", async ({ page, signIn, uniqueName }) => {
  const title = uniqueName("E2E touch lightbox card");
  await signIn(page, "amelia");
  await openBoard(page, "Platform Delivery");
  await createCard(page, title);
  const detail = await openCard(page, title);

  const fileName = "e2e-touch-lightbox.png";
  await detail.locator(".attach-upload input[type=file]").setInputFiles({ name: fileName, mimeType: "image/png", buffer: image });
  const row = detail.locator("li.attach-row").filter({ hasText: fileName });
  await row.locator(".attach-thumb").click();

  const lightbox = page.locator("k-image-lightbox");
  const img = lightbox.locator(".lb-img");
  await expect(img).toBeVisible();
  await expect(lightbox.locator(".lb-zoom-pct")).toHaveText("100%");
  const box = (await img.boundingBox())!;

  // Both fingers start on the backdrop above the fitted image, where a phone user's fingers
  // usually land; this is the case that did nothing when only the <img> listened for gestures.
  const y = box.y - 16;
  expect(y).toBeGreaterThan(0);
  const cdp = await page.context().newCDPSession(page);
  await pinch(cdp, [{ x: 150, y }, { x: 240, y }], [{ x: 40, y }, { x: 350, y }]);

  await expect.poll(() => zoomPercent(lightbox)).toBeGreaterThan(250);
  // Lifting the fingers off the backdrop must not be treated as a tap that closes the lightbox.
  await expect(lightbox).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pinched.png") });

  // Double-tap resets a zoomed image, and a second double-tap zooms back in.
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.touchscreen.tap(center.x, center.y);
  await page.touchscreen.tap(center.x, center.y);
  await expect(lightbox.locator(".lb-zoom-pct")).toHaveText("100%");
  await page.touchscreen.tap(center.x, center.y);
  await page.touchscreen.tap(center.x, center.y);
  await expect(lightbox.locator(".lb-zoom-pct")).toHaveText("250%");
  await expect(lightbox).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("double-tapped.png") });
});
