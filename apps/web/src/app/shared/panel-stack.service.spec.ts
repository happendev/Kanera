import { beforeEach, describe, expect, it, vi } from "vitest";
import { PanelStackService, type PanelDismissReason } from "./panel-stack.service";

/**
 * Pure arbitration logic, so these run without a TestBed: detached elements plus fake events with a
 * `composedPath()` stub, which is the only thing the service reads off an event.
 */
function pointerIn(target: Node): Event {
  const path: EventTarget[] = [];
  for (let node: Node | null = target; node; node = node.parentNode) path.push(node);
  return {
    type: "click",
    target,
    composedPath: () => path,
    stopPropagation: vi.fn(),
  } as unknown as Event;
}

function escapeKey(): Event & { stopPropagation: ReturnType<typeof vi.fn> } {
  return {
    type: "keydown",
    key: "Escape",
    stopPropagation: vi.fn(),
  } as unknown as Event & { stopPropagation: ReturnType<typeof vi.fn> };
}

describe("PanelStackService", () => {
  let stack: PanelStackService;
  /** Dismissal order, so tests can assert innermost-first. */
  let order: string[];

  beforeEach(() => {
    stack = new PanelStackService();
    order = [];
  });

  function layer(
    name: string,
    options: {
      hostEl?: HTMLElement | null;
      canDismiss?: (reason: PanelDismissReason) => boolean;
      keepOpenWithin?: () => HTMLElement[];
    } = {},
  ) {
    const hostEl = options.hostEl ?? document.createElement("div");
    const dismiss = vi.fn((reason: PanelDismissReason) => {
      order.push(name);
      void reason;
    });
    const unregister = stack.register({
      ...options,
      // An explicit `null` registers an element-less layer; the returned element is then unused.
      hostEl: options.hostEl === null ? null : hostEl,
      dismiss,
    });
    return { hostEl, dismiss, unregister };
  }

  it("dismisses a panel when the pointer lands outside it", () => {
    const panel = layer("panel");

    stack.handlePointer(pointerIn(document.createElement("span")));

    expect(panel.dismiss).toHaveBeenCalledWith("outside-pointer");
  });

  it("captures an outside click even when the target stops propagation", () => {
    const panel = layer("panel");
    const outside = document.body.appendChild(document.createElement("button"));
    outside.addEventListener("click", (event) => event.stopPropagation());

    outside.click();

    expect(panel.dismiss).toHaveBeenCalledWith("outside-pointer");
    outside.remove();
  });

  it("removes a dismissed layer before invoking its callback", () => {
    let depthDuringDismiss = -1;
    stack.register({
      hostEl: document.createElement("div"),
      dismiss: () => {
        depthDuringDismiss = stack.depth;
      },
    });

    stack.handlePointer(pointerIn(document.createElement("span")));

    expect(depthDuringDismiss).toBe(0);
  });

  it("hides a dismissed layer immediately instead of leaving it painted for the render tick", () => {
    const panel = layer("panel");
    panel.hostEl.classList.add("is-positioned");

    stack.handlePointer(pointerIn(document.createElement("span")));

    expect(panel.hostEl.classList.contains("is-positioned")).toBe(false);
  });

  it("leaves a panel open when the pointer lands inside it", () => {
    const panel = layer("panel");
    const row = panel.hostEl.appendChild(document.createElement("button"));

    stack.handlePointer(pointerIn(row));

    expect(panel.dismiss).not.toHaveBeenCalled();
  });

  it("keeps a nested panel's opener open when the pointer lands in the nested panel", () => {
    // The allowlist replacement: an inner panel that is a DOM child of the outer one derives its
    // opener chain automatically, so clicking the inner picker closes neither it nor the menu it
    // was opened from.
    const outer = layer("outer");
    const innerHost = outer.hostEl.appendChild(document.createElement("div"));
    const inner = layer("inner", { hostEl: innerHost });

    stack.handlePointer(pointerIn(innerHost.appendChild(document.createElement("button"))));

    expect(inner.dismiss).not.toHaveBeenCalled();
    expect(outer.dismiss).not.toHaveBeenCalled();
  });

  it("paints a nested panel above its opener", () => {
    const outer = layer("outer");
    const inner = layer("inner", { hostEl: outer.hostEl.appendChild(document.createElement("div")) });

    expect(outer.hostEl.style.zIndex).toBe("calc(var(--z-panel, 300) + 0)");
    expect(inner.hostEl.style.zIndex).toBe("calc(var(--z-panel, 300) + 1)");
  });

  it("dismisses a nested panel and its opener innermost-first when the pointer lands outside both", () => {
    const outer = layer("outer");
    const inner = layer("inner", { hostEl: outer.hostEl.appendChild(document.createElement("div")) });

    stack.handlePointer(pointerIn(document.createElement("span")));

    expect(order).toEqual(["inner", "outer"]);
    expect(inner.dismiss).toHaveBeenCalledWith("outside-pointer");
    expect(outer.dismiss).toHaveBeenCalledWith("outside-pointer");
  });

  it("lets a veto protect only the vetoing layer", () => {
    const vetoing = layer("vetoing", { canDismiss: () => false });
    const other = layer("other", {
      hostEl: vetoing.hostEl.appendChild(document.createElement("div")),
    });

    stack.handlePointer(pointerIn(document.createElement("span")));

    expect(vetoing.dismiss).not.toHaveBeenCalled();
    expect(other.dismiss).toHaveBeenCalledWith("outside-pointer");
  });

  it("treats keepOpenWithin regions as inside the panel", () => {
    const trigger = document.createElement("button");
    const panel = layer("panel", { keepOpenWithin: () => [trigger] });

    stack.handlePointer(pointerIn(trigger));

    expect(panel.dismiss).not.toHaveBeenCalled();
  });

  it("never dismisses an element-less layer on a pointer event", () => {
    // A keyboard-only layer (the card-detail drawer) has no box, so "outside" cannot mean anything.
    const drawer = layer("drawer", { hostEl: null });

    stack.handlePointer(pointerIn(document.createElement("span")));

    expect(drawer.dismiss).not.toHaveBeenCalled();
  });

  it("closes exactly one layer per Escape, innermost first, and claims the keypress", () => {
    const outer = layer("outer");
    const inner = layer("inner", { hostEl: outer.hostEl.appendChild(document.createElement("div")) });

    const first = escapeKey();
    stack.handleEscape(first);

    expect(inner.dismiss).toHaveBeenCalledWith("escape");
    expect(outer.dismiss).not.toHaveBeenCalled();
    expect(first.stopPropagation).toHaveBeenCalled();

    inner.unregister();
    stack.handleEscape(escapeKey());

    expect(outer.dismiss).toHaveBeenCalledWith("escape");
  });

  it("closes the innermost layer on Escape even when it registered first", () => {
    // "Innermost" is nesting depth, not arrival order — see the child-first registration case above.
    const outerHost = document.createElement("div");
    const inner = layer("inner", { hostEl: outerHost.appendChild(document.createElement("div")) });
    const outer = layer("outer", { hostEl: outerHost });

    stack.handleEscape(escapeKey());

    expect(inner.dismiss).toHaveBeenCalledWith("escape");
    expect(outer.dismiss).not.toHaveBeenCalled();
  });

  it("closes nothing when the innermost layer vetoes Escape", () => {
    const outer = layer("outer");
    const inner = layer("inner", {
      hostEl: outer.hostEl.appendChild(document.createElement("div")),
      canDismiss: (reason) => reason !== "escape",
    });

    stack.handleEscape(escapeKey());

    expect(inner.dismiss).not.toHaveBeenCalled();
    expect(outer.dismiss).not.toHaveBeenCalled();
  });

  it("handles the same forwarded event once, however many panels forward it", () => {
    const panel = layer("panel");
    const event = pointerIn(document.createElement("span"));

    stack.handlePointer(event);
    stack.handlePointer(event);
    stack.handlePointer(event);

    expect(panel.dismiss).toHaveBeenCalledTimes(1);
  });

  describe("opening a panel supersedes unrelated ones", () => {
    it("closes an unrelated open panel", () => {
      const first = layer("first");
      layer("second");

      expect(first.dismiss).toHaveBeenCalledWith("superseded");
    });

    it("spares the opener chain of the panel being registered", () => {
      const outer = layer("outer");
      const innerHost = outer.hostEl.appendChild(document.createElement("div"));
      layer("inner", { hostEl: innerHost });

      expect(outer.dismiss).not.toHaveBeenCalled();
    });

    it("spares an element-less layer, which containment can never match", () => {
      const drawer = layer("drawer", { hostEl: null });
      layer("picker");

      expect(drawer.dismiss).not.toHaveBeenCalled();
    });

    it("closeAll dismisses every panel, for a drawer that registers no layer of its own", () => {
      // Registered first so that opening the two panels never supersedes it, leaving `order` to
      // record only what closeAll itself did.
      const drawer = layer("drawer", { hostEl: null });
      const outer = layer("outer");
      layer("inner", { hostEl: outer.hostEl.appendChild(document.createElement("div")) });

      stack.closeAll();

      expect(order).toEqual(["inner", "outer"]);
      expect(drawer.dismiss).not.toHaveBeenCalled();
    });

    it("spares and adopts a nested panel that registered before its opener", () => {
      // Angular runs ngAfterViewInit child-first, so a menu and a submenu that become visible in the
      // same change-detection pass register submenu-first. The submenu must not be superseded when the
      // menu it lives inside arrives a moment later.
      const outerHost = document.createElement("div");
      const inner = layer("inner", { hostEl: outerHost.appendChild(document.createElement("div")) });
      const outer = layer("outer", { hostEl: outerHost });

      expect(inner.dismiss).not.toHaveBeenCalled();

      // Adoption, not just sparing: the click below lands in the submenu, and only a correct opener
      // chain protects the menu underneath it as well.
      stack.handlePointer(pointerIn(inner.hostEl.appendChild(document.createElement("button"))));

      expect(inner.dismiss).not.toHaveBeenCalled();
      expect(outer.dismiss).not.toHaveBeenCalled();
    });

    it("does not let a veto keep an unrelated panel open", () => {
      const confirming = layer("confirming", { canDismiss: (reason) => reason === "escape" });
      layer("other");

      expect(confirming.dismiss).toHaveBeenCalledWith("superseded");
    });
  });

  it("stops tracking a layer once it unregisters", () => {
    const panel = layer("panel");
    panel.unregister();

    expect(stack.depth).toBe(0);
    stack.handlePointer(pointerIn(document.createElement("span")));

    expect(panel.dismiss).not.toHaveBeenCalled();
  });
});
