import type { OnDestroy } from "@angular/core";
import { Directive, ElementRef, Injector, afterRenderEffect, inject } from "@angular/core";

/**
 * Behaviour for a horizontally scrolling tab strip (`.settings-tabs` on narrow screens).
 *
 * The strip hides its scrollbar and relies on edge fades to say "there is more". Two things pure
 * CSS cannot do:
 *
 * 1. Keep the selected tab on screen. Deep links and in-page navigation can select a tab that sits
 *    past the fold, and a strip parked at its start then shows the wrong tab as "current". After
 *    every render the `.active` child is scrolled into view when it is not fully visible.
 * 2. Fade only the edge that actually hides content. A fixed mask dims the first tab while the
 *    strip is at its start and the last tab once scrolled to the end. `data-scroll-start` and
 *    `data-scroll-end` mark which edges are reached so the stylesheet can drop that side's fade.
 *
 * On wide screens the same element is a wrapping row or a column; nothing overflows, both edge
 * attributes are set, and the scroll-into-view is a no-op.
 */
@Directive({
  selector: "[kTabStrip]",
  standalone: true,
})
export class TabStripDirective implements OnDestroy {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.updateEdges());
  // The selection is expressed only as a class on a child, and this directive has no signal to
  // track, so an afterRenderEffect alone would run once. Watching class changes is what makes a
  // tap on a half-visible tab pull it fully on screen.
  private readonly mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => this.revealActive());
  private lastActive: Element | null = null;

  constructor() {
    const el = this.element.nativeElement;
    el.addEventListener("scroll", this.updateEdges, { passive: true });
    this.resize?.observe(el);
    this.mutations?.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    afterRenderEffect(() => {
      this.revealActive();
      this.updateEdges();
    }, { injector: this.injector });
  }

  ngOnDestroy(): void {
    this.element.nativeElement.removeEventListener("scroll", this.updateEdges);
    this.resize?.disconnect();
    this.mutations?.disconnect();
  }

  private revealActive(): void {
    const el = this.element.nativeElement;
    const active = el.querySelector(".active");
    // Only react to a change of selection: re-centring on every render would fight the user's
    // own swipe through the strip.
    if (!active || active === this.lastActive) return;
    this.lastActive = active;
    if (el.scrollWidth <= el.clientWidth) return;
    const strip = el.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    if (tab.left >= strip.left && tab.right <= strip.right) return;
    // `inline: "center"` rather than `nearest`: a tab pulled flush to an edge sits under the fade.
    active.scrollIntoView({ block: "nearest", inline: "center" });
  }

  private readonly updateEdges = (): void => {
    const el = this.element.nativeElement;
    const max = el.scrollWidth - el.clientWidth;
    const atStart = max <= 1 || el.scrollLeft <= 1;
    const atEnd = max <= 1 || el.scrollLeft >= max - 1;
    el.toggleAttribute("data-scroll-start", atStart);
    el.toggleAttribute("data-scroll-end", atEnd);
  };
}
