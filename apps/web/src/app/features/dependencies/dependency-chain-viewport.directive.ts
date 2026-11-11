import { Directive, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, inject, input, signal } from "@angular/core";

/** Keep a chain's place in either the board scroller or Global Work's outer scroller while its
 * expensive tiles are absent. Focused controls and active edits must never lose their DOM. */
@Directive({
  selector: "[kDependencyChainViewport]",
  exportAs: "chainViewport",
  host: {
    "[style.min-height.px]": "mounted() ? null : reservedHeight()",
    "[attr.tabindex]": "mounted() ? null : 0",
    "[attr.data-viewport-mounted]": "mounted()",
    "(focusin)": "focused.set(true)",
    "(focusout)": "releaseFocus()",
  },
})
export class DependencyChainViewportDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  readonly estimatedHeight = input.required<number>();
  readonly contentVersion = input.required<unknown>();
  readonly width = input.required<number>();
  readonly pinned = input(false);
  readonly focused = signal(false);
  private readonly nearby = signal(typeof IntersectionObserver === "undefined");
  private readonly measured = signal<{ version: unknown; width: number; height: number } | null>(null);
  readonly mounted = computed(() => this.nearby() || this.focused() || this.pinned());
  readonly reservedHeight = computed(() => {
    const measured = this.measured();
    return measured && measured.version === this.contentVersion() && measured.width === this.width()
      ? measured.height : this.estimatedHeight();
  });

  private scrollLeft = 0;

  constructor() {
    // Restoring scrollLeft can force layout. Batch these writes after all chains have rendered,
    // and leave the native zero position alone for chains that have never scrolled sideways.
    afterRenderEffect({ write: () => {
      if (!this.mounted() || !this.scrollLeft) return;
      const scroller = this.host.nativeElement.querySelector<HTMLElement>(".dm-scroll");
      if (scroller) scroller.scrollLeft = this.scrollLeft;
    } });
    afterNextRender(() => {
      if (typeof IntersectionObserver === "undefined") return;
      const host = this.host.nativeElement;
      const rememberScroll = (event: Event) => {
        if (event.target instanceof HTMLElement && event.target.classList.contains("dm-scroll")) this.scrollLeft = event.target.scrollLeft;
      };
      host.addEventListener("scroll", rememberScroll, true);
      // Use the actual vertical scroller: viewport-root margins alone are clipped by nested
      // overflow panes. Global Work scrolls outside this component; board maps scroll on the host.
      let root: HTMLElement | null = host.parentElement;
      while (root && !(root.scrollHeight > root.clientHeight && /auto|scroll/.test(getComputedStyle(root).overflowY))) root = root.parentElement;
      // Overscan lets normal wheel/touch scrolling mount the next chain before it becomes visible.
      const visibility = new IntersectionObserver(([entry]) => {
        if (entry) this.nearby.set(entry.isIntersecting);
      }, { root, rootMargin: "600px 0px" });
      visibility.observe(host);
      const size = new ResizeObserver(([entry]) => {
        if (!this.mounted()) return;
        const height = entry?.borderBoxSize[0]?.blockSize ?? host.getBoundingClientRect().height;
        const previous = this.measured();
        if (height > 0 && (previous?.height !== height || previous.version !== this.contentVersion() || previous.width !== this.width())) {
          this.measured.set({ version: this.contentVersion(), width: this.width(), height });
        }
      });
      size.observe(host);
      this.destroyRef.onDestroy(() => { visibility.disconnect(); size.disconnect(); host.removeEventListener("scroll", rememberScroll, true); });
    });
  }

  releaseFocus(): void {
    // focusout precedes focusin when tabbing between controls in the same chain.
    queueMicrotask(() => {
      if (!this.destroyRef.destroyed) this.focused.set(this.host.nativeElement.contains(document.activeElement));
    });
  }
}
