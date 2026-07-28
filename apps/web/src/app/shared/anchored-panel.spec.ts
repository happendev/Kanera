import { describe, expect, it } from "vitest";
import { ANCHORED_SHEET_STYLES, anchoredSheetStyles, positionAnchoredPanel } from "./anchored-panel";

function anchorAt(rect: { top: number; bottom: number; left: number; right: number }): HTMLElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  }) as DOMRect;
  return anchor;
}

function place(
  rect: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
  placement?: Parameters<typeof positionAnchoredPanel>[2],
) {
  const host = document.createElement("div");
  const box = positionAnchoredPanel(host, anchorAt(rect), { ...placement, viewport });
  return {
    left: Number.parseInt(host.style.getPropertyValue("--ap-left"), 10),
    top: Number.parseInt(host.style.getPropertyValue("--ap-top"), 10),
    width: Number.parseInt(host.style.getPropertyValue("--ap-width"), 10),
    maxHeight: Number.parseInt(host.style.getPropertyValue("--ap-max-height"), 10),
    positioned: host.classList.contains("is-positioned"),
    // Extras for the extended API; the assertions above predate them and stay valid.
    widthVar: host.style.getPropertyValue("--ap-width"),
    bottomVar: host.style.getPropertyValue("--ap-bottom"),
    above: host.classList.contains("is-above"),
    box,
  };
}

/** Placement against a bare cursor position rather than an element. */
function placeAt(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  placement?: Parameters<typeof positionAnchoredPanel>[2],
) {
  const host = document.createElement("div");
  const box = positionAnchoredPanel(host, point, { ...placement, viewport });
  return {
    left: Number.parseInt(host.style.getPropertyValue("--ap-left"), 10),
    top: Number.parseInt(host.style.getPropertyValue("--ap-top"), 10),
    maxHeight: Number.parseInt(host.style.getPropertyValue("--ap-max-height"), 10),
    above: host.classList.contains("is-above"),
    box,
  };
}

describe("positionAnchoredPanel", () => {
  it("keeps a panel on screen when its trigger sits against the right edge", () => {
    const panel = place(
      { top: 40, bottom: 76, left: 1180, right: 1260 },
      { width: 1280, height: 900 },
      { align: "end", width: 320 },
    );

    expect(panel.left).toBeGreaterThanOrEqual(12);
    expect(panel.left + panel.width).toBeLessThanOrEqual(1280 - 12);
    expect(panel.positioned).toBe(true);
  });

  it("flips above the trigger when there is no usable room below", () => {
    const panel = place(
      { top: 780, bottom: 816, left: 100, right: 220 },
      { width: 1280, height: 860 },
      { width: 300, maxHeight: 400 },
    );

    expect(panel.top).toBeLessThan(780);
    expect(panel.top).toBeGreaterThanOrEqual(12);
    expect(panel.top + panel.maxHeight).toBeLessThanOrEqual(816);
  });

  it("narrows the panel to fit a phone viewport instead of overflowing it", () => {
    const panel = place(
      { top: 120, bottom: 156, left: 8, right: 360 },
      { width: 380, height: 720 },
      { width: 340 },
    );

    expect(panel.width).toBeLessThanOrEqual(380 - 24);
    expect(panel.left).toBeGreaterThanOrEqual(12);
  });

  it("still fits inside a viewport narrower than the normal two margins", () => {
    const panel = place(
      { top: 2, bottom: 7, left: 1, right: 10 },
      { width: 18, height: 20 },
      { width: 320, maxHeight: 420 },
    );

    expect(panel.left).toBeGreaterThanOrEqual(0);
    expect(panel.left + panel.width).toBeLessThanOrEqual(18);
    expect(panel.top).toBeGreaterThanOrEqual(0);
    expect(panel.top + panel.maxHeight).toBeLessThanOrEqual(20);
  });

  it("shrinks a tall panel below minHeight when neither side has enough room", () => {
    const panel = place(
      { top: 70, bottom: 90, left: 20, right: 60 },
      { width: 240, height: 160 },
      { width: 180, maxHeight: 420, minHeight: 240, margin: 8 },
    );

    expect(panel.maxHeight).toBeLessThan(240);
    expect(panel.top + panel.maxHeight).toBeLessThanOrEqual(160 - 8);
  });

  it("lets a measured menu shrink below its CSS minimum on a tiny viewport", () => {
    const host = document.createElement("div");
    Object.defineProperty(host, "offsetWidth", { configurable: true, value: 260 });

    const panel = positionAnchoredPanel(
      host,
      anchorAt({ top: 20, bottom: 40, left: 4, right: 20 }),
      { width: "measure", viewport: { width: 90, height: 200 }, margin: 8 },
    );

    expect(panel.width).toBe(74);
    expect(host.style.minWidth).toBe("0px");
    expect(host.style.maxWidth).toBe("74px");
  });

  it("keeps a deliberately narrow menu narrow instead of inflating it to a picker width", () => {
    const panel = place(
      { top: 100, bottom: 140, left: 200, right: 300 },
      { width: 1280, height: 900 },
      { width: 160 },
    );

    expect(panel.width).toBe(160);
  });

  it("leaves --ap-width unset when the panel sizes itself from content", () => {
    const panel = place(
      { top: 100, bottom: 140, left: 200, right: 300 },
      { width: 1280, height: 900 },
      { width: "measure" },
    );

    expect(panel.widthVar).toBe("");
    expect(panel.positioned).toBe(true);
  });

  describe("point anchors", () => {
    it("opens exactly at the cursor, with no gap shifting it off the click", () => {
      const panel = placeAt({ x: 400, y: 300 }, { width: 1280, height: 900 }, { width: 200, maxHeight: 200 });

      expect(panel.left).toBe(400);
      expect(panel.top).toBe(300);
    });

    it("clamps a cursor menu into the viewport on both axes", () => {
      const panel = placeAt(
        { x: 1270, y: 300 },
        { width: 1280, height: 900 },
        { width: 200, maxHeight: 190, minHeight: 150 },
      );

      expect(panel.left + panel.box.width).toBeLessThanOrEqual(1280 - 12);
      expect(panel.top + panel.maxHeight).toBeLessThanOrEqual(900 - 12);
    });

    it("flips a cursor menu above the click near the bottom edge", () => {
      const panel = placeAt(
        { x: 400, y: 890 },
        { width: 1280, height: 900 },
        { width: 200, maxHeight: 190, minHeight: 150 },
      );

      expect(panel.above).toBe(true);
      expect(panel.box.flipped).toBe(true);
      expect(panel.top).toBeLessThan(890);
    });
  });

  describe("minHeight", () => {
    const rect = { top: 700, bottom: 730, left: 100, right: 200 };
    const viewport = { width: 1280, height: 900 };

    it("keeps a short menu below its trigger when its real height fits", () => {
      const panel = place(rect, viewport, { width: 190, maxHeight: 190, minHeight: 150 });

      expect(panel.above).toBe(false);
      expect(panel.top).toBeGreaterThan(730);
    });

    it("flips the same anchor without minHeight, because 200px is assumed", () => {
      const panel = place(rect, viewport, { width: 190, maxHeight: 190 });

      expect(panel.above).toBe(true);
    });

    // Tablet band: too wide for the ≤560px bottom-sheet fallback, but narrow enough that a compact
    // toolbar collapses into a tall stacked panel. A picker triggered from low in that panel has to
    // flip above its trigger rather than run off the bottom of the screen.
    it("flips above a trigger sitting low in a tall panel on a tablet viewport", () => {
      const panel = place({ top: 560, bottom: 596, left: 24, right: 300 }, { width: 800, height: 700 }, {
        width: 260,
        maxHeight: 320,
      });

      expect(panel.above).toBe(true);
      expect(panel.box.flipped).toBe(true);
      expect(panel.top).toBeGreaterThanOrEqual(12);
    });
  });

  describe('side: "right"', () => {
    const viewport = { width: 1280, height: 900 };

    it("places beside the anchor and aligns the cross axis to its top", () => {
      const panel = place({ top: 300, bottom: 340, left: 100, right: 200 }, viewport, {
        side: "right",
        width: 300,
      });

      expect(panel.left).toBe(206);
      expect(panel.top).toBe(300);
      expect(panel.box.flipped).toBe(false);
    });

    it("flips to the anchor's left when there is no room on the right", () => {
      const panel = place({ top: 300, bottom: 340, left: 1100, right: 1200 }, viewport, {
        side: "right",
        width: 300,
      });

      expect(panel.left).toBe(794);
      expect(panel.box.flipped).toBe(true);
    });

    it("clamps vertically for an anchor near the bottom", () => {
      const panel = place({ top: 800, bottom: 840, left: 100, right: 200 }, viewport, {
        side: "right",
        width: 300,
        maxHeight: 300,
      });

      expect(panel.top + panel.maxHeight).toBeLessThanOrEqual(900 - 12);
    });
  });

  describe('align: "center"', () => {
    it("centres the panel on its anchor", () => {
      const panel = place(
        { top: 100, bottom: 140, left: 600, right: 700 },
        { width: 1280, height: 900 },
        { align: "center", width: 200 },
      );

      expect(panel.left).toBe(550);
    });

    it("clamps a centred panel away from the right edge", () => {
      const panel = place(
        { top: 100, bottom: 140, left: 1200, right: 1260 },
        { width: 1280, height: 900 },
        { align: "center", width: 200 },
      );

      expect(panel.left).toBe(1068);
    });
  });

  describe('side: "top"', () => {
    const viewport = { width: 1280, height: 900 };

    it("prefers above the anchor", () => {
      const panel = place({ top: 500, bottom: 540, left: 100, right: 200 }, viewport, {
        side: "top",
        maxHeight: 200,
      });

      expect(panel.above).toBe(true);
      expect(panel.box.flipped).toBe(false);
      expect(panel.bottomVar).toBe("406px");
    });

    it("falls back below when the anchor is near the top of the viewport", () => {
      const panel = place({ top: 40, bottom: 80, left: 100, right: 200 }, viewport, {
        side: "top",
        maxHeight: 200,
      });

      expect(panel.above).toBe(false);
      expect(panel.top).toBe(86);
      expect(panel.box.flipped).toBe(true);
    });
  });

  describe("crossOffset", () => {
    const viewport = { width: 1280, height: 900 };

    it("nudges an end-aligned panel past the anchor's right edge", () => {
      const panel = place({ top: 100, bottom: 140, left: 900, right: 1000 }, viewport, {
        align: "end",
        width: 160,
        crossOffset: 25,
      });

      expect(panel.left).toBe(865);
    });

    it("drops the nudge rather than overflowing at the right edge", () => {
      const panel = place({ top: 100, bottom: 140, left: 1170, right: 1270 }, viewport, {
        align: "end",
        width: 160,
        crossOffset: 25,
      });

      expect(panel.left).toBe(1108);
      expect(panel.left + panel.width).toBeLessThanOrEqual(1280 - 12);
    });
  });

  describe("flip bookkeeping", () => {
    const viewport = { width: 1280, height: 900 };

    it("publishes --ap-bottom and is-above when flipped, and still publishes --ap-top", () => {
      const panel = place({ top: 780, bottom: 816, left: 100, right: 220 }, viewport, {
        width: 300,
        maxHeight: 400,
      });

      expect(panel.above).toBe(true);
      expect(panel.bottomVar).not.toBe("");
      expect(Number.isNaN(panel.top)).toBe(false);
    });

    it("clears --ap-bottom and is-above when opening below", () => {
      const panel = place({ top: 100, bottom: 140, left: 100, right: 220 }, viewport, {
        width: 300,
        maxHeight: 400,
      });

      expect(panel.above).toBe(false);
      expect(panel.bottomVar).toBe("");
      expect(Number.isNaN(panel.top)).toBe(false);
    });

    it("uses the clamped top when a natural-height control must overlap an anchor", () => {
      const panel = place({ top: 280, bottom: 312, left: 520, right: 780 }, { width: 1024, height: 360 }, {
        width: 584,
        margin: 4,
        maxHeight: 352,
        minHeight: 352,
        preserveMinHeight: true,
      });

      expect(panel.top).toBe(4);
      expect(panel.above).toBe(false);
      expect(panel.bottomVar).toBe("");
      expect(panel.top + panel.maxHeight).toBeLessThanOrEqual(356);
    });
  });
});

describe("anchoredSheetStyles", () => {
  it("scopes phone sheet sizing to a caller-provided panel class", () => {
    const styles = anchoredSheetStyles("sp-panel");
    expect(styles).toContain("@media (max-width: 560px)");
    expect(styles).toContain(".sp-panel");
    expect(styles).not.toContain(".ap-panel");
  });

  it("keeps the existing constant byte-identical to the default helper", () => {
    expect(ANCHORED_SHEET_STYLES).toBe(anchoredSheetStyles());
  });
});
