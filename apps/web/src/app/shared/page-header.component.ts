import type { AfterViewInit, ElementRef, OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, input, signal, viewChild } from "@angular/core";

/**
 * The identity group's own floor, and the bar's flex gap, mirrored from page-header.component.scss.
 * Below this width an ellipsised title is a word fragment, so it is also the width at which the row
 * is judged to be out of space.
 */
const IDENTITY_FLOOR = 72;
const BAR_GAP = 8;

/** A computed length in pixels. Unresolved properties read as an empty string, which is zero here. */
function px(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * `chrome` — a page that holds a card/note collection and has a query toolbar below it (Board,
 * Global Work, Notes). A 56px bar on `--surface` with a bottom border, sized to sit flush above a
 * sticky `k-page-toolbar`.
 *
 * `page` — a reading or form column inside `.content` (Home, Share target, the settings pages).
 * Transparent, with a display-size title, and no expectation of a toolbar underneath.
 */
export type PageHeaderVariant = "chrome" | "page";

/**
 * The app's one page header — row 1 of the canonical two-row page chrome.
 *
 * Slot order is fixed and is the point of the component: lead icon → title → subtitle → `phMeta`
 * (avatars) → `phActions` (labelled buttons) → `phIcons` (icon cluster) → `phViews` (the view
 * switch, pinned right). Six pages had each invented their own order, so the view switch was beside
 * the title on the board and in the toolbar tail on Global Work.
 *
 * Two things this component owns that its callers must not re-implement:
 *
 * - **Bell clearance.** The shell's fixed buttons (notifications, Up next) sit over whatever is at
 *   the top-right of the page. The reserved band is two-dimensional: `--bell-clearance` wide, and
 *   `--bell-clearance-height` tall, which is what row 1 of a `chrome` header is sized to so that a
 *   stacked or wrapped control row clears them instead of running under them. A page
 *   that already sits some distance in from the viewport edge declares that as `--ph-edge-gap` so
 *   the same horizontal pixels are not paid twice.
 * - **Tail protection.** The identity group is the only flexible child, so a long title ellipsises
 *   instead of pushing the view switch off-screen — and once it hits its floor the bar wraps, so a
 *   header that genuinely cannot fit gets a second row instead of a vanished title and a tail
 *   spilling through the reserved band.
 * - **Fit.** Before it comes to that wrap, the header measures its own row and drops its controls'
 *   labels (`is-tight`, see toolbar-styles.scss). One icon-only row is a better answer than two
 *   rows, and the viewport breakpoint that normally drops labels cannot see this case at all — the
 *   sidebar is user-collapsible, so the same window gives a page 200px more or less to work with.
 */
@Component({
  selector: "k-page-header",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.is-chrome]": "variant() === 'chrome'",
    "[class.is-page]": "variant() === 'page'",
    "[class.is-tight]": "tight()",
  },
  template: `
    <div class="ph-bar" #bar>
      <div class="ph-identity">
        @if (icon(); as iconName) {
          <i
            class="ph-icon ti ti-{{ iconName }}"
            [class.is-badge]="iconBadge()"
            [style.color]="iconColor()"
            [style.background]="badgeBackground()"
            aria-hidden="true"
          ></i>
        }
        <div class="ph-titles">
          @if (eyebrow(); as eyebrowText) {
            <span class="ph-eyebrow">{{ eyebrowText }}</span>
          }
          <div class="ph-title-row">
            @if (loading()) {
              <span class="ph-title-skeleton" [attr.aria-label]="title()"></span>
            } @else {
              <h1 class="ph-title">{{ title() }}</h1>
              @if (subtitle(); as subtitleText) {
                <p class="ph-subtitle">{{ subtitleText }}</p>
              }
            }
          </div>
        </div>
        <ng-content select="[phMeta]" />
      </div>

      <div class="ph-tail" #tail>
        <ng-content select="[phActions]" />
        <ng-content select="[phIcons]" />
        <!--
          Wrapped, unlike its two siblings, so the stacked layout can push the view switch to the end
          of the control row with a scoped rule. Targeting the projected element itself would need
          ::ng-deep: projected nodes carry the *host page's* scoping attribute, not this component's.
        -->
        <div class="ph-views">
          <ng-content select="[phViews]" />
        </div>
      </div>
    </div>
  `,
  styleUrl: "./page-header.component.scss",
})
export class PageHeaderComponent implements AfterViewInit, OnDestroy {
  private readonly barRef = viewChild.required<ElementRef<HTMLElement>>("bar");
  private readonly tailRef = viewChild.required<ElementRef<HTMLElement>>("tail");

  /**
   * The row is out of space: the projected controls drop their labels (toolbar-styles.scss) rather
   * than letting the bar wrap.
   */
  protected readonly tight = signal(false);

  /**
   * The tail's width with its labels showing, held while they are hidden.
   *
   * This is what keeps the decision from oscillating. Collapsing the labels shrinks the very
   * measurement that caused the collapse, so re-measuring live would immediately find that the row
   * fits again, expand, no longer fit, and flip forever at one viewport width. Freezing the labelled
   * width means the expand and collapse thresholds are the same number, and the state is a plain
   * monotonic function of how wide the bar is. A tail whose content changes while collapsed (a count
   * in a label) leaves this slightly stale until the next expansion, which self-corrects.
   */
  private labelledTailWidth = 0;
  private observer: ResizeObserver | null = null;

  ngAfterViewInit(): void {
    // Absent under the unit-test DOM, where layout is not real anyway; the header then simply keeps
    // the labelled row the CSS breakpoints give it. Matches anchored-panel.directive.ts.
    if (typeof ResizeObserver === "undefined") return;

    // Both boxes matter: the bar changes with the window *and* with the sidebar, and the tail
    // changes when a page swaps its own controls (a "Save view" button that becomes "Manage view").
    this.observer = new ResizeObserver(() => this.measureFit());
    this.observer.observe(this.barRef().nativeElement);
    this.observer.observe(this.tailRef().nativeElement);
    this.measureFit();
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /**
   * Decides `is-tight` from the space the bar actually has, which no media query can know: the
   * clearance band is already the bar's own padding, so what is left inside it is exactly what one
   * row has to spend on the title and the controls.
   */
  private measureFit(): void {
    const bar = this.barRef().nativeElement;
    const tail = this.tailRef().nativeElement;
    // Detached, or in a hidden route: measuring here would report zero and collapse every label on
    // the way back in. Keep the last decision instead.
    if (bar.clientWidth === 0) return;

    const style = getComputedStyle(bar);
    const available = bar.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
    if (!this.tight()) this.labelledTailWidth = tail.offsetWidth;

    this.tight.set(available < IDENTITY_FLOOR + BAR_GAP + this.labelledTailWidth);
  }

  /** Tabler icon name without the `ti-` prefix. */
  readonly icon = input<string | null>(null);
  /** A CSS colour for the lead icon, typically `var(--color-teal)` from a board's icon colour. */
  readonly iconColor = input<string | null>(null);
  /**
   * Renders the lead icon as a tinted rounded square rather than a bare glyph — the settings pages'
   * identity badge. Tints with `iconColor` when one is given (a workspace's own colour), otherwise
   * solid accent.
   */
  readonly iconBadge = input(false);
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  /** Uppercase micro-label above the title. */
  readonly eyebrow = input<string | null>(null);
  readonly variant = input<PageHeaderVariant>("chrome");
  /**
   * Renders the title as a shimmer bar while the page's own data loads. Owned here so a page cannot
   * grow a second, separately-maintained skeleton header that drifts from the live one — which is
   * exactly what happened on the board, whose skeleton still rendered a filter button the live
   * header had replaced months earlier.
   */
  readonly loading = input(false);

  /**
   * Only the badge form gets a fill, and only a coloured one gets a tint: a bare glyph with a
   * background would read as a pressed button, and the accent-square default lives in CSS so the
   * theme owns it.
   */
  protected readonly badgeBackground = computed(() => {
    const color = this.iconColor();
    if (!this.iconBadge() || !color) return null;
    return `color-mix(in srgb, ${color} 20%, transparent)`;
  });
}
