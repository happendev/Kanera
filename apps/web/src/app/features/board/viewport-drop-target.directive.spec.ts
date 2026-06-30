import { describe, expect, it } from "vitest";
import { dropTargetBoundaryBottom, extendDropTargetRect, patchViewportDropTargetRect } from "./viewport-drop-target.directive";

describe("patchViewportDropTargetRect", () => {
  it("extends only the bottom edge to the kanban lane", () => {
    const lane = document.createElement("div");
    lane.className = "lists";
    const element = document.createElement("div");
    lane.appendChild(element);
    lane.getBoundingClientRect = () => new DOMRect(0, 20, 360, 620);
    element.getBoundingClientRect = () => new DOMRect(20, 40, 120, 160);

    patchViewportDropTargetRect(element, () => 720);

    const rect = element.getBoundingClientRect();
    expect(rect.left).toBe(20);
    expect(rect.right).toBe(140);
    expect(rect.top).toBe(40);
    expect(rect.width).toBe(120);
    expect(rect.bottom).toBe(640);
    expect(rect.height).toBe(600);
  });

  it("does not shrink a drop target that already reaches beyond the kanban lane", () => {
    const lane = document.createElement("div");
    lane.className = "lists";
    const element = document.createElement("div");
    lane.appendChild(element);
    lane.getBoundingClientRect = () => new DOMRect(0, 20, 360, 620);
    element.getBoundingClientRect = () => new DOMRect(20, 40, 120, 760);

    patchViewportDropTargetRect(element, () => 720);

    const rect = element.getBoundingClientRect();
    expect(rect.bottom).toBe(800);
    expect(rect.height).toBe(760);
  });

  it("falls back to the viewport when no kanban lane contains the target", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => new DOMRect(20, 40, 120, 160);

    patchViewportDropTargetRect(element, () => 720);

    const rect = element.getBoundingClientRect();
    expect(rect.bottom).toBe(720);
    expect(rect.height).toBe(680);
  });

  it("restores the original rect reader on cleanup", () => {
    const element = document.createElement("div");
    const original = () => new DOMRect(20, 40, 120, 160);
    element.getBoundingClientRect = original;

    const cleanup = patchViewportDropTargetRect(element, () => 720);
    expect(element.getBoundingClientRect).not.toBe(original);

    cleanup();

    expect(element.getBoundingClientRect().bottom).toBe(200);
  });
});

describe("dropTargetBoundaryBottom", () => {
  it("prefers the nearest kanban lane over the viewport", () => {
    const outer = document.createElement("div");
    outer.className = "lists";
    const inner = document.createElement("div");
    inner.className = "lists";
    const element = document.createElement("div");
    outer.appendChild(inner);
    inner.appendChild(element);
    outer.getBoundingClientRect = () => new DOMRect(0, 0, 300, 800);
    inner.getBoundingClientRect = () => new DOMRect(0, 0, 300, 500);

    expect(dropTargetBoundaryBottom(element, () => 720)).toBe(500);
  });
});

describe("extendDropTargetRect", () => {
  it("uses the list column width while extending through the lane", () => {
    const lane = document.createElement("div");
    lane.className = "lists";
    const host = document.createElement("k-list");
    const element = document.createElement("div");
    lane.appendChild(host);
    host.appendChild(element);
    lane.getBoundingClientRect = () => new DOMRect(0, 80, 420, 620);
    host.getBoundingClientRect = () => new DOMRect(40, 120, 270, 140);

    const rect = extendDropTargetRect(element, new DOMRect(52, 150, 246, 72), () => 900);

    expect(rect.left).toBe(40);
    expect(rect.right).toBe(310);
    expect(rect.top).toBe(150);
    expect(rect.bottom).toBe(700);
  });
});
