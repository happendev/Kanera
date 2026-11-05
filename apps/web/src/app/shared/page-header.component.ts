import type { AfterViewInit, ElementRef, OnDestroy } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from "@angular/core";
import { ShellNavService } from "./shell-nav.service";
import { TooltipDirective } from "./tooltip.directive";

/**
 * The identity group's CSS floor, and the bar's flex gap, mirrored from page-header.component.scss.
 * The floor is only the wrap fallback; the label-dropping decision uses TITLE_FLOOR below.
 */
const BAR_GAP = 8;

/**
 * How much of the title the header protects before it gives up a page's avatar stack (`is-crowded`)
 * and then the controls' labels (`is-tight`). The identity group's 72px CSS floor counts the lead icon and
 * the avatars too, so judging fit by that floor let a board with five avatars and a labelled
 * "New card" button shrink its title to a single letter at tablet widths before anything collapsed.
 * Capped by the title's own width: a short title needs no more than itself.
 */
const TITLE_FLOOR = 160;

/**
 * Spare width `is-named` keeps in hand beyond the exact fit, so a row that only just holds the
 * labelled view switch does not end with its last control pressed against the band.
 */
const NAMED_SLACK = 24;
/** What revealing an auto label adds beyond its text: its margin and the wider segment padding. */
const AUTO_LABEL_CHROME = 6 + 2 * 4;

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
 *   labels (`is-tight`, see toolbar-styles.scss), at every width and only when they do not fit. One
 *   icon-only row is a better answer than two rows, and no viewport breakpoint could make the call —
 *   the sidebar is user-collapsible, so the same window gives a page 200px more or less to work with.
 */
@Component({
  selector: "k-page-header",
  standalone: true,
  imports: [NgTemplateOutlet, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.is-chrome]": "variant() === 'chrome'",
    "[class.is-page]": "variant() === 'page'",
    "[class.is-crowded]": "crowded()",
    "[class.is-tight]": "tight()",
    "[class.is-named]": "named()",
  },
  template: `
    <!--
      Phones have no sidebar rail, so the navigation drawer opens from here, the first thing on
      every page (ShellNavService). Its dot marks overdue Up next.

      Unread notifications get a bell of their own joined to the menu button, so the most-visited
      drawer stays one tap away instead of two. It shows only while something is unread: a
      permanent second button would cost every crowded title row (the board's) ~44px for nothing.
    -->
    <ng-template #menuButton>
      <div class="ph-nav">
        <button type="button" class="ph-menu" (click)="nav.open()" [attr.aria-label]="nav.label()" [kTooltip]="nav.label()">
          <i class="ti ti-menu-2" aria-hidden="true"></i>
          @if (nav.overdue()) {
            <span class="ph-menu-dot" aria-hidden="true"></span>
          }
        </button>
        @if (nav.unreadNotifications(); as unread) {
          <button type="button" class="ph-bell" (click)="nav.openNotifications()" [attr.aria-label]="nav.notificationsLabel()" [kTooltip]="nav.notificationsLabel()">
            <i class="ti ti-bell-ringing" aria-hidden="true"></i>
            <span class="ph-bell-count" aria-hidden="true">{{ unread > 99 ? '99+' : unread }}</span>
          </button>
        }
      </div>
    </ng-template>
    @if (nav.drawerMode() && navBar()) {
      <div class="ph-nav-bar">
        <ng-container [ngTemplateOutlet]="menuButton" />
        @if (navBarTitle(); as barTitle) {
          <span class="ph-nav-bar-title">{{ barTitle }}</span>
        }
      </div>
    }
    <div class="ph-bar" #bar>
      <div class="ph-identity" #identity>
        @if (nav.drawerMode() && !navBar()) {
          <ng-container [ngTemplateOutlet]="menuButton" />
        }
        <!-- The bell is paid for with the lead icon, which the title beside it already names, so a
             crowded title row (the board's) only grows by a few pixels while something is unread. -->
        @if (icon(); as iconName) {
          @if (!bellInTitleRow()) {
            <i
              class="ph-icon ti ti-{{ iconName }}"
              [class.is-badge]="iconBadge()"
              [style.color]="iconColor()"
              [style.background]="badgeBackground()"
              aria-hidden="true"
            ></i>
          }
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
        <!--
          Actions and icons grouped so that, in the compact layout, they move as one unit: beside the
          title when it can stay readable, otherwise together on a row of their own — never split with
          the primary action stranded on the title row.
        -->
        <div class="ph-controls">
          <ng-content select="[phActions]" />
          <ng-content select="[phIcons]" />
        </div>
        <!--
          Wrapped, unlike its two siblings, so the compact layout can give the view switch a full-width
          row of its own with a scoped rule. Targeting the projected element itself would need
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
  protected readonly nav = inject(ShellNavService);
  /** Tells the shell a header is carrying the drawer button, so it does not show its fallback. */
  private readonly releaseNavTrigger = this.nav.registerTrigger();
  private readonly barRef = viewChild.required<ElementRef<HTMLElement>>("bar");
  private readonly tailRef = viewChild.required<ElementRef<HTMLElement>>("tail");
  private readonly identityRef = viewChild.required<ElementRef<HTMLElement>>("identity");

  /**
   * The row is short of space: decoration that has a compact form (the board's avatar stack, styled
   * by the page on `k-page-header.is-crowded`) takes it, and the controls keep their labels.
   */
  protected readonly crowded = signal(false);

  /**
   * The row is out of space even crowded: the projected controls drop their labels
   * (toolbar-styles.scss) rather than letting the bar wrap. Always also `crowded`.
   *
   * Two steps rather than one, because labels are what tell people which control is which and five
   * avatars are not: collapsing both together left a 1100px board header with a bare "+" for New
   * card while its label would have fitted in the space the faces gave back.
   */
  protected readonly tight = signal(false);

  /**
   * The row can afford the *active* view's label: the switch names where you are and keeps the rest
   * as icons with tooltips and accessible names (segmented.component.ts).
   *
   * Only ever the active one, on every page. Seven labels need ~500px, which a board header with its
   * avatars and New card, or My Cards with its subtitle, does not have at 1440px, while Team Cards, a
   * few controls lighter, did: one page named every view and the next only one, so the same switch
   * read as two different controls. The compact view row follows the same rule.
   */
  protected readonly named = signal(false);

  /**
   * Everything on the row except the title — lead icon, avatars, gaps and the tail — measured with
   * nothing collapsed, and held while anything is.
   *
   * This is what keeps the decision from oscillating. Collapsing (labels, the avatar stack) shrinks
   * the very measurement that caused the collapse, so re-measuring live would immediately find that
   * the row fits again, expand, no longer fit, and flip forever at one viewport width. Freezing it
   * means the expand and collapse thresholds are the same number. The title is kept out of the frozen
   * part and measured live, because it does not change with collapsing and does change when a reused
   * page swaps to another board.
   */
  private fullChromeWidth = 0;
  /**
   * The same with the row crowded (decoration compact, labels showing), held while tight. Null until
   * the crowded row has rendered once, since its width cannot be known before.
   */
  private crowdedChromeWidth: number | null = null;
  /** Which layout the frozen widths were measured in; null before the first measurement. */
  private lastCompact: boolean | null = null;
  private observer: ResizeObserver | null = null;

  ngAfterViewInit(): void {
    // Absent under the unit-test DOM, where layout is not real anyway; the header then simply keeps
    // its labelled row. Matches anchored-panel.directive.ts.
    if (typeof ResizeObserver === "undefined") return;

    // Both boxes matter: the bar changes with the window *and* with the sidebar, and the tail
    // changes when a page swaps its own controls (a "Save view" button that becomes "Manage view").
    this.observer = new ResizeObserver(() => this.measureFit());
    this.observer.observe(this.barRef().nativeElement);
    this.observer.observe(this.tailRef().nativeElement);
    // The compact layout's tail has no box of its own, so its controls group is observed directly.
    const controls = this.tailRef().nativeElement.querySelector(".ph-controls");
    if (controls) this.observer.observe(controls);
    // A title arriving after load, or changing on a reused page, changes what the row needs.
    const titles = this.identityRef().nativeElement.querySelector(".ph-titles");
    if (titles) this.observer.observe(titles);
    this.measureFit();
  }

  ngOnDestroy(): void {
    this.releaseNavTrigger();
    this.observer?.disconnect();
    this.observer = null;
  }

  /**
   * Decides `is-crowded` and `is-tight` from the space the bar actually has, which no media query
   * can know: the clearance band is already the bar's own padding, so what is left inside it is
   * exactly what one row has to spend on the title and the controls.
   */
  private measureFit(): void {
    const bar = this.barRef().nativeElement;
    const tail = this.tailRef().nativeElement;
    const identity = this.identityRef().nativeElement;
    // Detached, or in a hidden route: measuring here would report zero and collapse every label on
    // the way back in. Keep the last decision instead.
    if (bar.clientWidth === 0) return;

    const style = getComputedStyle(bar);
    const available = bar.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
    const title = identity.querySelector<HTMLElement>(".ph-title");
    // scrollWidth is the title's full text width even while it is ellipsised.
    const titleNeed = Math.min(title?.scrollWidth ?? 0, TITLE_FLOOR);

    // The active view's auto label, collapsed or revealed. scrollWidth is its natural width in either
    // state, so what revealing it costs is known without revealing it; subtracting it back out while
    // it shows keeps every other measurement independent of `is-named`, which is what stops the two
    // states feeding back into each other.
    // The named segment reserves the switch's longest label whichever view is active
    // (segmented.component.ts, --sg-named-width), so that is what naming costs, on every view alike.
    const activeLabel = tail.querySelector<HTMLElement>(".sg-btn.is-active .sg-auto-label");
    const switchLabels = activeLabel?.closest(".sg-track")?.querySelectorAll<HTMLElement>(".sg-auto-label") ?? [];
    const activeLabelWidth = activeLabel
      ? Math.max(activeLabel.scrollWidth, ...[...switchLabels].map((label) => label.scrollWidth)) + AUTO_LABEL_CHROME
      : 0;
    // Compact, the tail is display: contents and the view switch has a row of its own, so what shares
    // the title's row is the controls group alone. Its labels are still this row's to decide: a
    // viewport breakpoint used to drop them below 720px, so a phone showed a bare "+" for New card
    // beside a short title with half the row empty.
    const compact = getComputedStyle(tail).display === "contents";
    // The frozen widths belong to the layout they were measured in: the compact title row holds only
    // the controls group, the desktop row the whole tail. Crossing the breakpoint while collapsed
    // would judge one layout by the other's numbers, so everything comes back for a frame and is
    // measured afresh.
    if (this.lastCompact !== null && compact !== this.lastCompact && this.crowded()) {
      this.lastCompact = compact;
      this.crowdedChromeWidth = null;
      this.crowded.set(false);
      this.tight.set(false);
      requestAnimationFrame(() => this.measureFit());
      return;
    }
    this.lastCompact = compact;
    const rowTail = compact ? tail.querySelector<HTMLElement>(".ph-controls") : tail;
    const revealed = this.named() ? activeLabelWidth : 0;
    const tailWidth = Math.max(0, (rowTail?.offsetWidth ?? 0) - revealed);

    if (!this.tight()) {
      const children = [...identity.children] as HTMLElement[];
      let identityChrome = 0;
      for (const child of children) {
        if (!child.classList.contains("ph-titles")) identityChrome += child.offsetWidth;
      }
      identityChrome += px(getComputedStyle(identity).columnGap) * Math.max(0, children.length - 1);
      const chrome = identityChrome + (tailWidth > 0 ? BAR_GAP + tailWidth : 0);
      if (this.crowded()) this.crowdedChromeWidth = chrome;
      else this.fullChromeWidth = chrome;
    }

    const wasCrowded = this.crowded();
    const wasTight = this.tight();
    const crowded = available < titleNeed + this.fullChromeWidth;
    if (!crowded) this.crowdedChromeWidth = null;
    // Unknown until the crowded row has rendered: labels stay meanwhile, and the pass scheduled
    // below decides once it has.
    const tight = crowded && this.crowdedChromeWidth !== null && available < titleNeed + this.crowdedChromeWidth;
    this.crowded.set(crowded);
    this.tight.set(tight);
    // A step changes boxes this component may not observe (the avatar stack lives in the page's
    // projected meta), and leaving one decides from widths frozen in a narrower window: a 1920px
    // header once kept its view switch icon-only with 800px to spare. One more pass after the new
    // state has rendered measures it for real; it schedules nothing further once the state holds.
    if (crowded !== wasCrowded || tight !== wasTight) requestAnimationFrame(() => this.measureFit());

    // Naming needs the *whole* title and subtitle, not the protected floor: the label is a nicety, and
    // must never be the reason a title ellipsises. Never in the compact layout, where the switch has
    // a row of its own and names its active view there itself (segmented.component.ts).
    const subtitle = identity.querySelector<HTMLElement>(".ph-subtitle");
    const fullTitle = (title?.scrollWidth ?? 0) + (subtitle ? BAR_GAP + subtitle.scrollWidth : 0);
    const spare = available - fullTitle - this.fullChromeWidth - NAMED_SLACK;
    this.named.set(!crowded && !compact && tailWidth > 0 && activeLabelWidth > 0 && spare >= activeLabelWidth);
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
   * `page` variant only: in drawer mode the menu button gets a header bar of its own, full-bleed on
   * the page surface like a chrome header's row, with the display title below it (Home). Without
   * it the menu sits beside a display-size title, which on a phone read as a stray glyph floating
   * by the heading while every other top-level page opened with a bar. Off for headers inside a
   * card (the settings pages), where a bleeding bar would cut across the card.
   */
  readonly navBar = input(false);
  /**
   * The page's name in that bar. A bar holding only the menu button read as a header whose title
   * had failed to render, beside every other phone page that names itself there. Plain text, not a
   * heading: the display title below stays the page's h1.
   */
  readonly navBarTitle = input<string | null>(null);
  /**
   * Renders the title as a shimmer bar while the page's own data loads. Owned here so a page cannot
   * grow a second, separately-maintained skeleton header that drifts from the live one — which is
   * exactly what happened on the board, whose skeleton still rendered a filter button the live
   * header had replaced months earlier.
   */
  readonly loading = input(false);

  protected readonly bellInTitleRow = computed(() => this.nav.drawerMode() && !this.navBar() && this.nav.unreadNotifications() > 0);

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
