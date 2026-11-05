import { DestroyRef, Directive, ElementRef, effect, inject, input } from "@angular/core";
import { mediaQuerySignal } from "../../shared/media-query.signal";

/**
 * Sizes a Global Work lanes block on a phone to the lane in view rather than the tallest lane.
 *
 * A phone shows one lane at a time (the canvas's clean-peek width), but a flex row is as tall as its
 * tallest item wherever it is. A short lane on screen then sat over a band of empty canvas as tall as
 * the longest lane off to the side, and whatever followed (the assigned checklist, the next
 * workspace) started a screen further down. No CSS can follow the scroll position to one item, so
 * this measures the lane that holds most of the scrollport once a swipe settles and sets the block's
 * height to it. Taller neighbours are clipped at the bottom by the canvas's own overflow-y: hidden,
 * which only ever shows on the peek strip, and they get their full height when swiped into view.
 *
 * Off above the phone breakpoint (several lanes share the row there) and while the lanes fill the
 * frame, where the height is the shell's, not the content's.
 */
@Directive({ selector: "[kPhoneLaneHeight]" })
export class PhoneLaneHeightDirective {
  /** False while the lanes fill the frame. */
  readonly enabled = input(true, { alias: "kPhoneLaneHeight" });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  // The canvas's phone breakpoint, where it sizes lanes to one-plus-a-peek.
  private readonly phone = mediaQuerySignal("(max-width: 480px)");
  private teardown: (() => void) | null = null;

  constructor() {
    effect(() => {
      const active = this.enabled() && this.phone();
      this.stop();
      if (active) this.start();
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  private start(): void {
    if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Measured once the swipe settles, not per frame: resizing mid-swipe moved everything below the
    // lanes under the reader's thumb. `scrollend` is not everywhere yet, so a short debounce instead.
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.measure(), 120);
    };
    // A lane changes height when a card is added, moved or expanded, and lanes come and go as
    // filters change, so every child is observed and the set is refreshed when the children change.
    const resize = new ResizeObserver(() => this.measure());
    const observeChildren = () => {
      resize.disconnect();
      for (const child of Array.from(this.host.children)) resize.observe(child);
    };
    const mutations = new MutationObserver(() => {
      observeChildren();
      this.measure();
    });
    observeChildren();
    mutations.observe(this.host, { childList: true });
    this.host.addEventListener("scroll", onScroll, { passive: true });
    this.measure();
    this.teardown = () => {
      clearTimeout(timer);
      resize.disconnect();
      mutations.disconnect();
      this.host.removeEventListener("scroll", onScroll);
      this.host.style.removeProperty("height");
    };
  }

  private stop(): void {
    this.teardown?.();
    this.teardown = null;
  }

  private measure(): void {
    const view = this.host.getBoundingClientRect();
    let lane: HTMLElement | null = null;
    let laneVisible = 0;
    for (const child of Array.from(this.host.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const rect = child.getBoundingClientRect();
      const visible = Math.min(rect.right, view.right) - Math.max(rect.left, view.left);
      if (visible > laneVisible) {
        laneVisible = visible;
        lane = child;
      }
    }
    if (!lane) {
      this.host.style.removeProperty("height");
      return;
    }
    // Border-box, so the canvas's own vertical padding (room for a drop target's ring) is added back.
    const style = getComputedStyle(this.host);
    const height = lane.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    this.host.style.height = `${Math.ceil(height)}px`;
  }
}
