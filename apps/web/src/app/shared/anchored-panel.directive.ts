import type { AfterViewInit, OnChanges, OnDestroy } from "@angular/core";
import { Directive, ElementRef, inject, input, isDevMode, output } from "@angular/core";
import {
  positionAnchoredPanel,
  type AnchoredPanelBox,
  type AnchoredPanelPlacement,
  type AnchorTarget,
} from "./anchored-panel";
import { PanelStackService, type PanelDismissReason } from "./panel-stack.service";

/**
 * Imperative configuration, for a popover component that lists this directive in `hostDirectives`.
 *
 * `hostDirectives` input mappings must be statically analysable and cannot bind to the host
 * component's own signal inputs, so a component configures the directive from its constructor
 * instead. The upside is that no popover's public API changes: components keep their own
 * `close`/`dismissed` outputs and none of their consumer templates are touched.
 */
export type AnchoredPanelConfig = {
  placement?: () => AnchoredPanelPlacement;
  /** Defaults to the host's `parentElement`, which is how every popover in the app is mounted. */
  anchor?: () => AnchorTarget | null | undefined;
  /** Skip placement and listeners: the panel is embedded in flow rather than floating. */
  inline?: () => boolean;
  /**
   * Called when the stack decides this panel should close. Omitting it keeps the panel out of the
   * stack entirely — right for a hover-driven, `pointer-events: none` panel that nothing dismisses.
   */
  onDismiss?: (reason: PanelDismissReason) => void;
  /** Called after every placement, with the resolved box. */
  onPlaced?: (box: AnchoredPanelBox) => void;
  canDismiss?: (reason: PanelDismissReason) => boolean;
  keepOpenWithin?: () => readonly (HTMLElement | null | undefined)[];
};

/**
 * One lifecycle for every anchored floating panel: placement, reposition on scroll/resize,
 * outside-click and Escape dismissal via `PanelStackService`, and a dev-mode warning when an
 * ancestor has trapped the panel.
 *
 * Usable declaratively on a plain element — many panels are a `<div>` inside a bigger component, not
 * a component of their own:
 *
 * ```html
 * <div class="nav-context-menu" kAnchoredPanel [apAnchor]="menuAt()" [apPlacement]="{ minHeight: 150 }"
 *      (apDismissed)="menuAt.set(null)"></div>
 * ```
 */
@Directive({
  selector: "[kAnchoredPanel]",
  standalone: true,
  host: {
    class: "k-anchored-panel",
  },
})
export class AnchoredPanelDirective implements AfterViewInit, OnChanges, OnDestroy {
  private readonly hostRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly stack = inject(PanelStackService);

  readonly apPlacement = input<AnchoredPanelPlacement>({});
  /** Anchor override. Defaults to the host's parent element. */
  readonly apAnchor = input<AnchorTarget | null>(null);
  /** Rendered in flow instead of floating: no placement, no listeners, no stack registration. */
  readonly apInline = input(false);
  /** Opt out of the stack, for a panel that is never dismissed by a click or Escape. */
  readonly apNoDismiss = input(false);
  readonly apCanDismiss = input<((reason: PanelDismissReason) => boolean) | null>(null);
  readonly apKeepOpenWithin = input<readonly (HTMLElement | null | undefined)[]>([]);

  readonly apDismissed = output<PanelDismissReason>();
  readonly apPlaced = output<AnchoredPanelBox>();

  private config: AnchoredPanelConfig | null = null;
  private unregister: (() => void) | null = null;
  private listening = false;
  private ready = false;
  private resizeObserver: ResizeObserver | null = null;
  private observedAnchor: HTMLElement | null = null;
  private readonly onViewportChange = () => this.reposition();

  /** Configure from a host component's constructor. See `AnchoredPanelConfig`. */
  configure(config: AnchoredPanelConfig): void {
    this.config = config;
  }

  ngAfterViewInit(): void {
    this.ready = true;
    if (this.isInline()) {
      // The embedded copy still gets `is-positioned`, because the CSS that strips a popover down to an
      // in-flow panel keys off the same class contract as the floating one.
      this.hostRef.nativeElement.classList.add("is-positioned");
      return;
    }

    // Registering here — not in the constructor and not via `afterNextRender` — is load-bearing. The
    // click that opened this panel is still propagating while the constructor runs, so a layer
    // registered any earlier would see that very click as an outside pointer and close itself
    // immediately. By `ngAfterViewInit` the opening click has finished.
    if (this.isDismissible()) {
      this.unregister = this.stack.register({
        hostEl: this.hostRef.nativeElement,
        // Capture-phase outside dismissal runs before a trigger's click handler. Counting the anchor
        // as inside lets that handler toggle its own panel closed instead of dismissing then reopening.
        keepOpenWithin: () => this.keepOpenRegions(),
        canDismiss: (reason) => this.config?.canDismiss?.(reason) ?? this.apCanDismiss()?.(reason) ?? true,
        dismiss: (reason) => this.emitDismissed(reason),
      });
    }

    this.reposition();
    window.addEventListener("resize", this.onViewportChange);
    // Capture phase: a panel anchored inside the horizontally-scrolling kanban or the card-detail
    // scroller must follow that scroller, and scroll events from an inner element never reach
    // `window` in the bubble phase.
    window.addEventListener("scroll", this.onViewportChange, true);
    this.listening = true;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.reposition());
      this.resizeObserver.observe(this.hostRef.nativeElement);
      this.observeAnchor();
    }

    // One frame later, deliberately. At `ngAfterViewInit` a panel this one just superseded is still
    // mounted for the rest of the tick, so hit testing now would report the outgoing panel as an
    // occluder on every swap between two popovers. Waiting also lets styles and any open animation
    // settle before the rect is measured. Re-check `isConnected`: a panel dismissed within the same
    // tick has nothing worth diagnosing.
    if (isDevMode()) {
      const host = this.hostRef.nativeElement;
      requestAnimationFrame(() => {
        if (host.isConnected) warnOnTrappedPanel(host);
      });
    }
  }

  ngOnDestroy(): void {
    this.ready = false;
    if (this.listening) {
      window.removeEventListener("resize", this.onViewportChange);
      window.removeEventListener("scroll", this.onViewportChange, true);
      this.listening = false;
    }
    this.unregister?.();
    this.unregister = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedAnchor = null;
  }

  ngOnChanges(): void {
    if (!this.ready || this.isInline()) return;
    queueMicrotask(() => this.reposition());
  }

  /**
   * Re-place the panel. Public because some panels change size while open — a title textarea that
   * grows, an inline "Archive all cards?" confirmation — and that has to re-run placement.
   */
  reposition(): void {
    if (!this.ready || this.isInline()) return;
    const anchor = this.resolveAnchor();
    if (!anchor) return;

    const box = positionAnchoredPanel(this.hostRef.nativeElement, anchor, this.resolvePlacement());
    this.observeAnchor();
    this.config?.onPlaced?.(box);
    this.apPlaced.emit(box);
  }

  private emitDismissed(reason: PanelDismissReason): void {
    this.config?.onDismiss?.(reason);
    this.apDismissed.emit(reason);
  }

  private resolveAnchor(): AnchorTarget | null {
    return this.config?.anchor?.() ?? this.apAnchor() ?? this.hostRef.nativeElement.parentElement;
  }

  private resolvePlacement(): AnchoredPanelPlacement {
    return this.config?.placement?.() ?? this.apPlacement();
  }

  private isInline(): boolean {
    return this.config?.inline?.() ?? this.apInline();
  }

  private isDismissible(): boolean {
    // Imperative callers opt in by providing `onDismiss`; declarative ones are in by default, since
    // `(apDismissed)` is the reason to reach for the directive on a plain element.
    return this.config ? !!this.config.onDismiss : !this.apNoDismiss();
  }

  private keepOpenRegions(): readonly (HTMLElement | null | undefined)[] {
    const anchor = this.resolveAnchor();
    const anchorElement = anchor instanceof HTMLElement ? anchor : null;
    return [
      anchorElement,
      ...this.apKeepOpenWithin(),
      ...(this.config?.keepOpenWithin?.() ?? []),
    ];
  }

  private observeAnchor(): void {
    if (!this.resizeObserver) return;
    const anchor = this.resolveAnchor();
    const next = anchor instanceof HTMLElement ? anchor : null;
    if (next === this.observedAnchor) return;
    if (this.observedAnchor) this.resizeObserver.unobserve(this.observedAnchor);
    if (next) this.resizeObserver.observe(next);
    this.observedAnchor = next;
  }
}

/**
 * Properties that *can* make an element a containing block for `position: fixed` descendants. Used
 * only to name a culprit once a trap has actually been measured — the list is not itself the test.
 * `container-type: inline-size` is on it but does not trap in practice (verified in Chromium), which
 * is exactly why this walk never fires on its own.
 */
const CONTAINING_BLOCK_PROPS = [
  "transform",
  "perspective",
  "filter",
  "backdrop-filter",
  "will-change",
  "contain",
  "container-type",
] as const;

const NEUTRAL_VALUES = new Set(["", "none", "auto", "normal", "initial"]);

/**
 * Dev-only diagnostic for the two ways an anchored panel silently ends up in the wrong place.
 *
 * The containing-block check is *empirical*: placement publishes viewport coordinates into
 * `--ap-left`/`--ap-top`, so if an ancestor has captured the panel the browser resolves those against
 * that ancestor's box instead and the rendered rect no longer matches what was asked for. Measuring
 * the difference catches every trapping mechanism, including ones not on the list above, and — unlike
 * sniffing ancestor properties — never cries wolf on a property that turns out to be harmless.
 */
function warnOnTrappedPanel(host: HTMLElement): void {
  const style = getComputedStyle(host);
  // A panel whose CSS has deliberately taken it out of viewport positioning — a responsive branch
  // that flattens a popover into an in-flow or absolutely-positioned sheet — is expected not to sit
  // where placement asked. Neither check below means anything for it.
  if (style.position !== "fixed") return;
  const declaredLeft = Number.parseFloat(style.getPropertyValue("--ap-left"));
  const declaredTop = Number.parseFloat(style.getPropertyValue("--ap-top"));
  const rect = host.getBoundingClientRect();

  // 1px of tolerance for subpixel layout; a real trap is off by tens or hundreds.
  if (
    Number.isFinite(declaredLeft)
    && Number.isFinite(declaredTop)
    && (Math.abs(rect.left - declaredLeft) > 1 || Math.abs(rect.top - declaredTop) > 1)
  ) {
    console.warn(
      `[kAnchoredPanel] This panel asked to be placed at (${Math.round(declaredLeft)}, `
        + `${Math.round(declaredTop)}) but rendered at (${Math.round(rect.left)}, ${Math.round(rect.top)}). `
        + `An ancestor is acting as a containing block for position: fixed, so placement is resolving `
        + `against its box instead of the viewport. Candidates: ${describeCandidates(host)}. `
        + `Remove the property, or render the panel outside that subtree.`,
      host,
    );
  }

  warnOnOccludedPanel(host, style);
}

/**
 * `position: fixed` escapes layout containment but never stacking-context containment: an ancestor
 * with a z-index caps every descendant at that ancestor's layer, and no amount of `--z-panel` can
 * lift the panel past it.
 *
 * Whether that *matters* is not decidable from the property values. A sticky page toolbar takes
 * `--z-sticky` and caps the panels opened from it, but every one of its siblings sits below that, so
 * nothing is occluded — and a sibling that legitimately covers the panel (the card-detail drawer at
 * `--z-drawer`) is supposed to win. So ask the browser instead: sample points inside the panel and see
 * whether the topmost element there is the panel. Anything else painting over a panel the instant it opens is the real bug, and
 * this catches it whatever the cause — an ancestor stacking context, a stray high z-index, or an
 * overlay left mounted.
 */
function warnOnOccludedPanel(host: HTMLElement, style: CSSStyleDeclaration): void {
  // A hover-driven panel is deliberately click-through, so hit testing would always name whatever is
  // underneath it.
  if (style.pointerEvents === "none") return;
  const rect = host.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;

  // Inset from the edges so a 1px border or a rounded corner never decides the answer.
  const inset = 3;
  const points: [number, number][] = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.top + inset],
    [rect.left + inset, rect.bottom - inset],
    [rect.right - inset, rect.bottom - inset],
  ];

  for (const [x, y] of points) {
    const top = document.elementFromPoint(x, y);
    // Off-viewport points hit-test to nothing; the placement check above already covers clamping.
    if (!top || host.contains(top) || top === host) continue;
    console.warn(
      `[kAnchoredPanel] <${top.tagName.toLowerCase()}${classSuffix(top)}> is painting over this panel at `
        + `(${Math.round(x)}, ${Math.round(y)}). Usually an ancestor with a z-index has capped the panel `
        + `at its own layer, so raising --z-panel cannot fix it: ${describeStackingAncestors(host)}. `
        + `Remove that ancestor's z-index, or move the panel out of its subtree.`,
      host,
      top,
    );
    return;
  }
}

/** Ancestor stacking contexts, nearest first — the usual explanation for a capped panel. */
function describeStackingAncestors(host: HTMLElement): string {
  const found: string[] = [];
  for (let el = host.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.position === "static" || style.zIndex === "auto") continue;
    found.push(`<${el.tagName.toLowerCase()}${classSuffix(el)}> (z-index: ${style.zIndex})`);
  }
  return found.length ? found.join(", ") : "no ancestor stacking context found";
}

/** Ancestors declaring a property that could explain a measured trap, nearest first. */
function describeCandidates(host: HTMLElement): string {
  const found: string[] = [];
  for (let el = host.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el);
    const hits = CONTAINING_BLOCK_PROPS.filter((prop) => !NEUTRAL_VALUES.has(style.getPropertyValue(prop)));
    if (hits.length) {
      const values = hits.map((prop) => `${prop}: ${style.getPropertyValue(prop)}`).join("; ");
      found.push(`<${el.tagName.toLowerCase()}${classSuffix(el)}> (${values})`);
    }
  }
  return found.length ? found.join(", ") : "none found — check for a property this walk does not know about";
}

function classSuffix(el: Element): string {
  const first = el.classList.item(0);
  return first ? `.${first}` : "";
}
