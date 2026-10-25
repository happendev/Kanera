import type { AfterViewInit, OnDestroy } from "@angular/core";
import { Directive, ElementRef, inject } from "@angular/core";

/** Set on a `.k-toolbar-collapsible-label` control whose label did not fit (toolbar-styles.scss). */
const DROPPED = "is-label-dropped";

/**
 * Keeps the labels of a row's `.k-toolbar-collapsible-label` controls for as long as the row has
 * room for them, and drops them one at a time, from the end, once it does not.
 *
 * This replaced a viewport breakpoint that dropped every label below 720px, which could not see the
 * row it was deciding for: a table toolbar on a 600px phone went icon-only with 280px to spare,
 * while the same breakpoint did nothing for a narrow row beside an open sidebar.
 *
 * "Room" means the row stays the height it is with every label dropped and does not overflow. That
 * suits a wrapping row (the label that would push a control onto a second line is the one that
 * goes) and a nowrap row alike. Labels return in DOM order and stop at the first that does not fit,
 * so a long label late in the row can never come back while an earlier, shorter one is hidden —
 * which control is labelled does not jump about as the width changes.
 *
 * Not for k-page-header: there the title ellipsises instead of the row growing, so height cannot
 * tell when a label is costing it; PageHeaderComponent.measureFit decides that row.
 */
@Directive({
  selector: "[kFitLabels]",
  standalone: true,
})
export class FitLabelsDirective implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;

  ngAfterViewInit(): void {
    // Absent under the unit-test DOM, where layout is not real anyway; labels simply stay.
    if (typeof ResizeObserver === "undefined") return;

    const row = this.host.nativeElement;
    // The row's own box changes with the window and the sidebar. Refitting can change its height,
    // which notifies again, but the second pass reaches the same answer and changes nothing.
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(row);
    // A control appearing or a label's text changing ("Group: List" → "Group: Assignee") need not
    // resize the row. Attribute changes, including our own class toggles, are deliberately ignored.
    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(() => this.fit());
      this.mutationObserver.observe(row, { childList: true, subtree: true, characterData: true });
    }
    this.fit();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
  }

  /** Runs synchronously inside one observer callback, so the trial layouts are never painted. */
  private fit(): void {
    const row = this.host.nativeElement;
    // Detached, or in a hidden route: keep the last decision rather than fitting against zero.
    if (row.clientWidth === 0) return;

    const controls = [...row.querySelectorAll<HTMLElement>(".k-toolbar-collapsible-label")]
      .filter((control) => control.offsetParent !== null);
    if (controls.length === 0) return;

    for (const control of controls) control.classList.add(DROPPED);
    const height = row.offsetHeight;
    const fits = () => row.offsetHeight <= height && row.scrollWidth <= row.clientWidth;

    for (const control of controls) {
      control.classList.remove(DROPPED);
      if (!fits()) {
        control.classList.add(DROPPED);
        break;
      }
    }
  }
}
