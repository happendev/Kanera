import type { AfterViewInit, OnDestroy } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal } from "@angular/core";
import { TooltipDirective } from "./tooltip.directive";

/** The labelled segment's inline padding and icon-to-label gap, mirrored from the `.sg-fits` rules. */
const LABELLED_PADDING = 10;
const LABEL_GAP = 6;

/** A computed length in pixels. Unresolved properties read as an empty string, which is zero here. */
function px(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type SegmentedOption<T extends string = string> = {
  id: T;
  /** Tabler icon name without the `ti-` prefix. Required when `showLabels` is false. */
  icon?: string;
  label: string;
  /** Defaults to `label`; only shown when the segment renders icon-only. */
  tooltip?: string;
  /**
   * The visible text for `autoLabels` mode ("Table" rather than "Table view"): beside its icon the
   * word "view" is redundant, while `label` stays the full accessible name. Defaults to `label`.
   */
  shortLabel?: string;
  disabled?: boolean;
};

/**
 * The app's one segmented control.
 *
 * Replaces four near-identical implementations that had each picked a different active treatment:
 * the board's view toggle (raised pill + accent text, 28×26 buttons), Global Work's display switch
 * (raised pill, 30×36), work-done's presets, and the notifications Unread/All pills. Pattern B —
 * a recessed `--surface-2` track with a raised `--surface` pill — won because it is the only one
 * that reads correctly on both the board's tinted header and a plain page surface.
 *
 * One size everywhere: the track is always --h-lg, so a switch in a drawer or a card section lines up
 * with the 36px buttons and fields beside it. Do not reintroduce a dense variant.
 *
 * Keep the active treatment here and only here. Divergent per-caller active states are the mess this
 * control exists to have cleaned up.
 *
 * Icon-only by default (`showLabels` false), because the primary caller is a five-way view switch
 * that has to survive a phone width; a tooltip carries the name.
 */
@Component({
  selector: "k-segmented",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "[class.sg-fill]": "filling()",
    "[class.sg-fits]": "fits()",
    "[class.sg-scroll]": "scrolling()",
    "[class.sg-named]": "named()",
    "[class.sg-more-start]": "moreStart()",
    "[class.sg-more-end]": "moreEnd()",
  },
  template: `
    <div class="sg-track" [class.is-equal]="equalWidths()" role="group" [attr.aria-label]="ariaLabel()">
      @for (option of options(); track option.id) {
        <button
          type="button"
          class="sg-btn"
          [class.is-active]="option.id === value()"
          [disabled]="!!option.disabled"
          [attr.aria-pressed]="option.id === value()"
          [attr.aria-label]="showLabels() ? null : option.label"
          [kTooltip]="option.tooltip ?? option.label"
          [kTooltipDisabled]="showLabels()"
          [kTooltipTruncationTarget]="autoLabels() ? '.sg-auto-label' : null"
          (click)="valueChange.emit(option.id)"
        >
          @if (option.icon) {
            <i class="ti ti-{{ option.icon }}" aria-hidden="true"></i>
          }
          @if (showLabels()) {
            <span>{{ option.label }}</span>
          } @else if (autoLabels()) {
            <span class="sg-auto-label" aria-hidden="true">{{ option.shortLabel ?? option.label }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      /* --sg-fill-width / --sg-fill-flex let a container stretch the track and share its width
         equally between segments (k-page-header's compact view row) without reaching into this
         component's styles. Unset, the control keeps its intrinsic size. */
      :host {
        display: inline-flex;
        width: var(--sg-fill-width, auto);
        min-width: 0;
      }

      .sg-track {
        display: inline-flex;
        align-items: center;
        flex: none;
        gap: 2px;
        height: var(--h-lg);
        padding: 3px;
        /* A recessed track with a raised pill for the active segment, rather than per-button borders
           that clashed with tinted toolbar backgrounds. Themed pair (--sg-track-bg / --sg-pill-bg in
           styles.scss): --surface-3 under a --surface pill in light, where --surface-2 was within a
           few shades of the pill and the selection vanished; dark inverts it so the pill is still the
           raised, lighter layer. */
        background: var(--sg-track-bg);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        width: var(--sg-fill-width, auto);
      }

      .sg-btn {
        flex: var(--sg-fill-flex, 0 1 auto);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-width: 30px;
        height: 100%;
        /* --sg-btn-padding: a caller whose short labelled segments sit beside roomier controls
           (work done's 7d|14d|30d next to its Today and Week buttons) evens their inline room. */
        padding: 0 var(--sg-btn-padding, 6px);
        color: var(--text-muted);
        background: transparent;
        border: 0;
        border-radius: calc(var(--radius) - 3px);
        font-size: var(--text-base);
        font-weight: 500;
        cursor: pointer;
        transition: background 0.12s, color 0.12s, box-shadow 0.12s;
      }

      /* Equal segments via an intrinsically-sized inline-grid: 1fr columns in a shrink-to-fit grid
         all resolve to the widest item's max-content size, which flex cannot do without a definite
         track width. align-items: stretch replaces the flex centring the buttons relied on. */
      .sg-track.is-equal {
        display: inline-grid;
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
        align-items: stretch;
      }

      .sg-btn i {
        font-size: 15px;
        line-height: 1;
      }

      /* autoLabels: the label is always rendered but collapsed to zero width, so the host can measure
         its natural width (scrollWidth) to decide whether there is room, and reveal it with one rule
         (k-page-header.is-named, below) without re-rendering. Collapsed, it is also what
         tells the tooltip to show: kTooltipTruncationTarget sees it as cut short, so the tooltip
         appears exactly while the text is hidden and stands down once it is visible. The gap moves
         onto the label's margin so a collapsed label costs no width at all. */
      .sg-btn:has(.sg-auto-label) {
        gap: 0;
      }

      .sg-auto-label {
        display: inline-block;
        max-width: 0;
        overflow: hidden;
        white-space: nowrap;
      }

      /* The page header's view switch names the active view and only the active view: the selection
         reads as a word, and the rest stay icons with tooltips. The header sets .is-named once its
         whole title, every control and that one label fit with margin
         (PageHeaderComponent.measureFit). Its compact row is scroll mode (.sg-scroll, below), which
         always names it (.sg-named) and scrolls when a long name cannot fit beside the icons: an
         icon-only phone switch left the current view unnamed, and several of the glyphs are
         ambiguous on their own.
         :host-context rather than a rule in toolbar-styles.scss: that file is compiled into each
         page's scoped styles, which cannot reach this component's own spans. */
      :host-context(k-page-header.is-named) .sg-btn.is-active .sg-auto-label {
        max-width: none;
        margin-left: 6px;
      }

      :host-context(k-page-header.is-named) .sg-btn.is-active:has(.sg-auto-label) {
        padding-inline: 10px;
      }

      /* The compact row's name is set tighter than the desktop header's: six 44px icons and a named
         Board, Table, Notes, Timeline or Calendar then fit a 390px phone's row without scrolling. */
      :host(.sg-scroll.sg-named) .sg-btn.is-active .sg-auto-label {
        max-width: none;
        margin-left: 4px;
      }

      :host(.sg-scroll.sg-named) .sg-btn.is-active:has(.sg-auto-label) {
        padding-inline: 6px;
      }

      /* The named segment is as wide as the longest name in the set would make it, whichever view is
         active (--sg-named-width, measured in measureFit), with its own name centred. Sized to its own
         label, the switch changed width on every view change and the header's actions beside it
         jumped: Board and Work done put New card 30px apart. */
      :host-context(k-page-header.is-named) .sg-btn.is-active:has(.sg-auto-label) {
        min-width: var(--sg-named-width, 0px);
      }

      /* The same reveal for a switch sharing a page toolbar's search slot. The toolbar sets
         .is-roomy once the fixed-width search field, the switch's labels and every control fit
         (PageToolbarComponent.measureRoom), so the labels give way before search ever does. */
      :host-context(k-page-toolbar.is-roomy) .sg-auto-label {
        max-width: none;
        margin-left: 6px;
      }

      :host-context(k-page-toolbar.is-roomy) .sg-btn:has(.sg-auto-label) {
        padding-inline: 10px;
      }

      /* A switch filling a row of its own (the compact header's view row, the collapsed toolbar's
         layout row) measures that row itself and names its segments whenever they all fit
         (measureFit, below). This replaced a fixed 440px container threshold, which was right for a
         four-way switch and left a seven-way one overflowing or a two-way one bare. */
      :host(.sg-fits) .sg-auto-label {
        max-width: none;
        margin-left: 6px;
      }

      :host(.sg-fits) .sg-btn:has(.sg-auto-label) {
        padding-inline: 10px;
      }

      /* Hover lifts the label and nothing else. The background has to be restated here, because the
         base button rule in styles.scss paints background: var(--accent-hover) on hover and
         button:hover:not(:disabled) — (0,2,1) — outranks the plain .sg-btn fill, which is only
         (0,2,0) once Angular appends its scoping attribute. Hovering an inactive segment therefore
         flooded it with accent, so a hover read as a selection. */
      .sg-btn:hover:not(:disabled) {
        color: var(--text);
        background: transparent;
      }

      /* The global button rule focuses with a 2px --bg + 4px --accent halo, which on a segment
         paints an accent blob over the neighbouring segments and the track itself — it reads as a
         selection state rather than as focus. A thin outline inset inside the pill keeps the
         indicator (and its contrast) without touching the control's resting look. */
      .sg-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
        box-shadow: none;
      }

      .sg-btn.is-active:focus-visible {
        box-shadow: var(--sg-pill-shadow);
      }

      /* The raised pill is the one and only fill in this control, so the hover rule above must not
         take it away when the active segment is the one under the cursor — hence the explicit
         :hover here, which outranks it. The --border-strong ring carries the selection: the pill
         fill against the light track is too close in value to read on its own. */
      .sg-btn.is-active,
      .sg-btn.is-active:hover:not(:disabled) {
        --sg-pill-shadow: 0 0 0 1px var(--border-strong), var(--shadow-sm);
        color: var(--text);
        background: var(--sg-pill-bg);
        box-shadow: var(--sg-pill-shadow);
      }

      .sg-btn:disabled {
        cursor: default;
        opacity: 0.55;
      }

      /* Coarse pointers get the shared 44px floor; see toolbar-styles.scss. Standalone toolbars can
         set --sg-touch-track-height / --sg-touch-target-size to keep full 44px button targets. */
      @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
        .sg-track {
          height: var(--sg-touch-track-height, 44px);
        }

        .sg-btn {
          min-width: var(--sg-touch-target-size, 44px);
          min-height: var(--sg-touch-target-size, 0px);
        }

        /* The glyph is the whole label of an inactive segment, and 15px of it in a 44px target read
           as a speck; 18px matches the sidebar's touch glyphs. */
        .sg-btn i {
          font-size: 18px;
        }
      }

      /* A switch stretched across a row shares that row exactly, so no segment can be pushed past
         its end. Segments are wider than the floor whenever the row allows, and keep their full touch
         height when it does not. */
      :host(.sg-fill) .sg-btn {
        min-width: 0;
      }

      /* Scroll mode (--sg-fill-scroll, the compact header's view row): stretched across the row like
         fill mode, but segments never shrink below their content or the touch floor, and the switch
         scrolls sideways instead. Squeezing seven segments to fit made every target narrower than the
         floor, and a 320px phone clipped Notes off the screen outright. */
      /* The track itself is the scroller, so its recessed fill stays whole at the row's width and
         only the segments move inside it. The host used to scroll a max-content track and mask the
         row's ends, which faded the track's own chrome too. */
      :host(.sg-scroll) {
        position: relative;
      }

      /* No border and a 2px inset: the row is a phone's chrome, where every pixel of height and width
         is spent before content (the switch sits between the title row and the search row). The
         recessed track fill alone separates the track from the bar, and the width saved is what
         lets the active view keep its name beside six icons. Proximity rather than mandatory snap: a
         mandatory snap fought the programmatic scroll that brings the selection into view, and could
         pull it back under the edge fade. */
      :host(.sg-scroll) .sg-track {
        min-width: 0;
        gap: 0;
        padding: 2px;
        border: 0;
        overflow-x: auto;
        overflow-y: hidden;
        overscroll-behavior-x: contain;
        scrollbar-width: none;
        scroll-snap-type: x proximity;
        /* The track's own padding, so a snapped segment rests exactly where the first one does at the
           start. */
        scroll-padding-inline: 2px;
      }

      :host(.sg-scroll) .sg-track::-webkit-scrollbar {
        display: none;
      }

      /* The scroll cue: the track's own fill (--sg-track-bg, the .sg-track background) fading in at
         whichever end has more to show, and only that end (.sg-more-start / .sg-more-end, set from
         the scroll position). Fill on fill is invisible over the empty track, so the fade reaches
         into the nearest glyph (fadeWidth, measureScrollLayout) and the cue is that glyph
         easing out under the edge: solid only over the bare track, then a soft ramp across the
         glyph, so it dims rather than reading as cut in half. A shade of --text read as a grey smudge
         on the light track and dimmed the active pill when it sat at the edge. */
      :host(.sg-scroll)::before,
      :host(.sg-scroll)::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 1;
        pointer-events: none;
        opacity: 0;
        transition: opacity var(--motion-fast);
      }

      /* Each fade is as wide as the scroll it stands for, up to fadeWidth (measureScroll): a
         track scrolled 8px faded a full 32px at its start and erased most of the first glyph. */
      :host(.sg-scroll)::before {
        left: 0;
        width: var(--sg-fade-start, 0px);
        border-radius: var(--radius) 0 0 var(--radius);
        background: linear-gradient(to right, var(--sg-track-bg) 30%, transparent);
      }

      :host(.sg-scroll)::after {
        right: 0;
        width: var(--sg-fade-end, 0px);
        border-radius: 0 var(--radius) var(--radius) 0;
        background: linear-gradient(to left, var(--sg-track-bg) 30%, transparent);
      }

      :host(.sg-scroll.sg-more-start)::before,
      :host(.sg-scroll.sg-more-end)::after {
        opacity: 1;
      }

      /* Icons sit at exactly the floor and the active segment takes whatever the row has left, so its
         name has room and the icons do not drift a few pixels wider on one view than another. */
      :host(.sg-scroll) .sg-btn {
        flex: none;
        min-width: 30px;
        scroll-snap-align: start;
      }

      :host(.sg-scroll) .sg-btn.is-active {
        flex: 1 0 auto;
      }

      /* 40px rather than the 44px floor: the segments are still 44px wide, and this row stacks between
         the 44px title row and the 44px search field, where a 44px track pushed a phone's chrome to
         160px before the first card. The 36px pills are the same height the bordered 44px track held. */
      @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
        :host(.sg-scroll) .sg-track {
          height: 40px;
        }

        :host(.sg-scroll) .sg-btn {
          min-width: 44px;
        }
      }
    `,
  ],
})
export class SegmentedComponent<T extends string = string> implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;

  /** Stretched across a row by its container (`--sg-fill-width`); see `.sg-fill`. */
  protected readonly filling = signal(false);
  /** Fill mode only: every auto label fits on this switch's own row (see `.sg-fits`). */
  protected readonly fits = signal(false);
  /** Stretched and allowed to scroll (`--sg-fill-scroll`); see `.sg-scroll`. */
  protected readonly scrolling = signal(false);
  /** Scroll mode: segments are hidden past the start / end of the track, which shows the fade there. */
  protected readonly moreStart = signal(false);
  protected readonly moreEnd = signal(false);
  /** Scroll mode always names the active segment (see `.sg-named`). */
  protected readonly named = computed(() => this.scrolling() && this.autoLabels() && !this.showLabels());
  private readonly onTrackScroll = (): void => this.measureScroll();
  /** Scroll mode: the widest an edge fade may grow (measureScrollLayout). */
  private fadeWidth = 12;

  readonly options = input.required<readonly SegmentedOption<T>[]>();
  readonly value = input<T | null>(null);
  /** False renders icon + tooltip only, which is what a 4–5 way switch needs to fit a phone. */
  readonly showLabels = input(false);
  /**
   * Icon-only, with a short label revealed whenever its row has room for it: decided by the toolbar
   * laying out that row (`is-roomy`), or by the switch itself when it fills a row of its own. In a
   * page header only the active segment is ever named (`is-named`, scroll mode). Ignored when
   * `showLabels` is set.
   */
  readonly autoLabels = input(false);
  /**
   * Sizes every segment to the widest one. Opt-in because most label-mode callers are a range or
   * period switch where uneven widths read fine; a two-way state toggle does not — "Unread"/"All"
   * at intrinsic widths looks like two different controls sharing a track.
   */
  readonly equalWidths = input(false);
  readonly ariaLabel = input.required<string>();

  readonly valueChange = output<T>();

  constructor() {
    // A scrolling switch keeps the selection on screen, whether it changed by a tap, a shortcut or a
    // route. After the frame, so the newly active segment has its label and its final width.
    effect(() => {
      this.value();
      if (this.scrolling() && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
          // The named segment's width follows its label, so the overflow and fade are re-measured first.
          this.measureFit();
          this.scrollActiveIntoView();
        });
      }
    });
  }

  ngAfterViewInit(): void {
    // Absent under the unit-test DOM, where layout is not real anyway; the switch stays icon-only.
    if (typeof ResizeObserver === "undefined") return;
    const host = this.host.nativeElement;
    this.resizeObserver = new ResizeObserver(() => this.measureFit());
    this.resizeObserver.observe(host);
    // New options, or a label changing language, need not resize the stretched host.
    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(() => this.measureFit());
      this.mutationObserver.observe(host, { childList: true, subtree: true, characterData: true });
    }
    host.querySelector(".sg-track")?.addEventListener("scroll", this.onTrackScroll, { passive: true });
    this.measureFit();
    // Label widths are measured text; a web font arriving after the first pass changes them without
    // resizing the host.
    void document.fonts?.ready.then(() => this.measureFit());
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.host.nativeElement.querySelector(".sg-track")?.removeEventListener("scroll", this.onTrackScroll);
  }

  /**
   * Only a switch stretched across a row (`--sg-fill-width`) knows its own room: its width is the
   * row's. An intrinsically sized switch is as wide as its content, so whoever lays out its row
   * decides instead (k-page-header `is-named`, k-page-toolbar `is-roomy`).
   *
   * The labelled width is computed rather than tried, from each label's scrollWidth (its natural
   * width even while collapsed) plus the segment's labelled padding, so the decision is the same
   * whether the labels currently show or not and cannot oscillate.
   */
  private measureFit(): void {
    const host = this.host.nativeElement;
    if (host.clientWidth === 0) return;
    const hostStyle = getComputedStyle(host);
    const fill = hostStyle.getPropertyValue("--sg-fill-width").trim() !== "";
    this.filling.set(fill);
    // Scroll mode names only the active segment, by CSS; it never needs the all-labels decision.
    const scroll = fill && !["", "0"].includes(hostStyle.getPropertyValue("--sg-fill-scroll").trim());
    this.scrolling.set(scroll);
    const track = host.querySelector<HTMLElement>(".sg-track");
    const buttons = track ? [...track.querySelectorAll<HTMLElement>(".sg-btn")] : [];
    const labelledWidth = (button: HTMLElement): number => {
      const label = button.querySelector<HTMLElement>(".sg-auto-label");
      const icon = button.querySelector<HTMLElement>("i");
      return 2 * LABELLED_PADDING + (icon?.offsetWidth ?? 0) + (label ? LABEL_GAP + label.scrollWidth : 0);
    };
    // The page header names only the active segment; reserving the widest name keeps the switch one
    // width across views (see the --sg-named-width rule).
    if (this.autoLabels() && !this.showLabels() && buttons.length) {
      host.style.setProperty("--sg-named-width", `${Math.max(...buttons.map(labelledWidth))}px`);
    }
    if (track) this.measureScrollLayout(track, buttons);
    this.measureScroll();
    if (!this.autoLabels() || this.showLabels() || !fill || scroll || !track) {
      this.fits.set(false);
      return;
    }

    const trackStyle = getComputedStyle(track);
    let need = px(trackStyle.paddingLeft) + px(trackStyle.paddingRight)
      + px(trackStyle.borderLeftWidth) + px(trackStyle.borderRightWidth)
      + px(trackStyle.columnGap) * Math.max(0, buttons.length - 1);
    for (const button of buttons) {
      need += Math.max(px(getComputedStyle(button).minWidth), labelledWidth(button));
    }
    this.fits.set(need <= host.clientWidth);
  }

  /**
   * Scroll mode always names the active segment, and when that name does not fit beside the other
   * segments at the touch floor (Work done or Dependencies at 390px, anything at 320px) the track
   * scrolls and keeps the selection in view (scrollActiveIntoView). The earlier rule dropped the name
   * instead, which left a phone's current view unnamed behind glyphs that are ambiguous on their
   * own; scrolling hides at most the far icons, and the edge fade says there are more.
   *
   * What is left to measure is the fade: from the track's inner edge to three quarters across the
   * nearest glyph, capped where it still reads as a soft edge rather than a band. Computed from CSS
   * sizes, never from rendered segment widths, so laying out the switch cannot change its inputs.
   */
  private measureScrollLayout(track: HTMLElement, buttons: HTMLElement[]): void {
    const sample = buttons.find((button) => !button.classList.contains("is-active")) ?? buttons[0];
    if (!this.scrolling() || !sample) return;
    const style = getComputedStyle(track);
    const base = px(getComputedStyle(sample).minWidth);
    const glyph = sample.querySelector<HTMLElement>("i")?.offsetWidth ?? 0;
    this.fadeWidth = Math.min(32, px(style.paddingLeft) + (base - glyph) / 2 + glyph * 0.75);
  }

  /** Which ends of a scrolling track have segments past them; a pixel of slack absorbs subpixel widths. */
  private measureScroll(): void {
    const track = this.host.nativeElement.querySelector<HTMLElement>(".sg-track");
    if (!this.scrolling() || !track) {
      this.moreStart.set(false);
      this.moreEnd.set(false);
      return;
    }
    const max = track.scrollWidth - track.clientWidth;
    const toEnd = max - track.scrollLeft;
    this.moreStart.set(max > 1 && track.scrollLeft > 1);
    this.moreEnd.set(max > 1 && toEnd > 1);
    // Each end's fade covers no more than what is actually scrolled past it, so a nudge of a few
    // pixels dims only those pixels instead of most of the end glyph.
    const style = this.host.nativeElement.style;
    style.setProperty("--sg-fade-start", `${Math.min(this.fadeWidth, Math.max(0, track.scrollLeft))}px`);
    style.setProperty("--sg-fade-end", `${Math.min(this.fadeWidth, Math.max(0, toEnd))}px`);
  }

  /**
   * Brings the selection fully into view with its neighbour on either side as lead where the track
   * has one, so the edge fade (which covers part of the end segment while more lies past it) never
   * sits over the selected pill. Lands on a segment start, the proximity snap's own resting point, so
   * the snap has nothing to correct; at either end the browser clamps the scroll and that end's fade
   * is gone.
   */
  private scrollActiveIntoView(): void {
    const track = this.host.nativeElement.querySelector<HTMLElement>(".sg-track");
    const buttons = track ? [...track.querySelectorAll<HTMLElement>(".sg-btn")] : [];
    const index = buttons.findIndex((button) => button.classList.contains("is-active"));
    if (!track || index < 0 || track.scrollWidth <= track.clientWidth) {
      this.measureScroll();
      return;
    }
    const style = getComputedStyle(track);
    const bounds = track.getBoundingClientRect();
    const origin = bounds.left + px(style.borderLeftWidth) + px(style.paddingLeft);
    const visible = bounds.right - px(style.borderRightWidth) - px(style.paddingRight) - origin;
    // Each segment's start and end in scroll coordinates: scrollLeft = starts[i] rests segment i
    // against the track's inner start edge.
    const spans = buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      const start = rect.left - origin + track.scrollLeft;
      return { start, end: start + rect.width };
    });
    const first = spans[Math.max(0, index - 1)]!;
    const last = spans[Math.min(spans.length - 1, index + 1)]!;
    const scroll = track.scrollLeft;
    if (first.start < scroll - 1) {
      track.scrollLeft = first.start;
    } else if (last.end > scroll + visible + 1) {
      const need = last.end - visible;
      track.scrollLeft = spans.find((span) => span.start >= need - 1 && span.start <= spans[index]!.start)?.start ?? need;
    }
    this.measureScroll();
  }
}
