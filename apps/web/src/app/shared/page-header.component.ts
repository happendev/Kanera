import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

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
 * - **Bell clearance.** The globally-fixed notifications bell overlaps whatever is at the top-right
 *   of the page. The reserved band is `--bell-clearance`; a page that already sits some distance in
 *   from the viewport edge declares that as `--ph-edge-gap` so the same pixels are not paid twice.
 * - **Tail protection.** The identity group is the only flexible child, so a long title ellipsises
 *   instead of pushing the view switch off-screen.
 */
@Component({
  selector: "k-page-header",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.is-chrome]": "variant() === 'chrome'",
    "[class.is-page]": "variant() === 'page'",
  },
  template: `
    <div class="ph-bar">
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

      <div class="ph-tail">
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
export class PageHeaderComponent {
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
