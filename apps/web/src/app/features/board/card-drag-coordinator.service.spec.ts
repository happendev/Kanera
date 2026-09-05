import { afterEach, describe, expect, it } from "vitest";
import { CardDragCoordinator } from "./card-drag-coordinator.service";

describe("drag cursor ownership", () => {
  const coordinator = new CardDragCoordinator();
  const elements: HTMLElement[] = [];
  const element = () => {
    const el = document.createElement("button");
    document.body.append(el);
    elements.push(el);
    return el;
  };
  afterEach(() => {
    coordinator.end();
    for (const el of elements.splice(0)) el.remove();
  });

  it("only overrides the current hit element and restores prior inline styles on end", () => {
    const source = element();
    const other = element();
    source.style.setProperty("cursor", "crosshair", "important");
    coordinator.start("list-1", source);
    expect(source.style.cursor).toBe("grabbing");
    expect(other.style.cursor).toBe("");
    other.dispatchEvent(new Event("pointerover", { bubbles: true, composed: true }));
    expect(source.style.cursor).toBe("crosshair");
    expect(source.style.getPropertyPriority("cursor")).toBe("important");
    expect(other.style.cursor).toBe("grabbing");
    coordinator.end();
    expect(other.style.cursor).toBe("");
    expect(document.body.classList.contains("is-card-dragging")).toBe(false);
    source.dispatchEvent(new Event("pointerover", { bubbles: true, composed: true }));
    expect(source.style.cursor).toBe("crosshair");
  });
});
