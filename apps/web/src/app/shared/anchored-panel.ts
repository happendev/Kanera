/**
 * Shared viewport-aware placement for anchored popovers (pickers, menus, context menus).
 *
 * The panel is a `position: fixed` host anchored to a trigger element, a pre-measured rect, or a
 * cursor point. Placement is published as CSS custom properties instead of inline `top`/`left` so a
 * panel's own media query can re-anchor it — the opt-in `ANCHORED_SHEET_STYLES` branch turns the same
 * panel into a bottom sheet without fighting inline styles.
 *
 * Beware ancestors that become a containing block for `position: fixed`: a trapped panel is placed
 * against that ancestor's box instead of the viewport. `transform`, `perspective`, `filter`,
 * `backdrop-filter` and `will-change` all do it — `app-shell.component.scss` `.sidebar.swiping` is a
 * live case, and `page-toolbar.component.ts` plus `work-done-day.component.scss` carry comments about
 * why `backdrop-filter` was kept off them. `container-type` does *not* trap fixed descendants
 * despite applying layout containment (verified against `card-detail.component.scss` `.panel`).
 * Rather than trusting either list, `AnchoredPanelDirective` measures the rendered rect against the
 * coordinates published below and warns in dev mode when they disagree.
 */
/** A bare cursor position — right-click and "open at pointer" menus. */
export type AnchorPoint = { x: number; y: number };
/** A pre-measured viewport-space box; a real `DOMRect` satisfies it. */
export type AnchorRect = Pick<DOMRect, "top" | "bottom" | "left" | "right">;
export type AnchorTarget = HTMLElement | AnchorRect | AnchorPoint;

export type AnchoredPanelPlacement = {
  /**
   * Which side of the anchor the panel prefers. This is the *main* axis; `align` is then always the
   * cross axis (horizontal for `bottom`/`top`, vertical for `right`).
   */
  side?: "bottom" | "top" | "right";
  /** Which edge of the panel lines up with the anchor on the cross axis. */
  align?: "start" | "end" | "center";
  /**
   * Preferred panel width in px, always clamped to the viewport. `"measure"` sizes from content
   * instead: `--ap-width` is left unset so the panel's own `min-width`/`max-width` rules win, and
   * the rendered width is measured only to clamp the horizontal position.
   */
  width?: number | "measure";
  /** Space between the anchor and the panel along the main axis. */
  gap?: number;
  /** Shift along the cross axis, in the positive direction (right for `bottom`/`top`, down for `right`). */
  crossOffset?: number;
  /** Minimum distance kept from every viewport edge. */
  margin?: number;
  /** Upper bound on panel height; the panel scrolls internally beyond it. */
  maxHeight?: number;
  /**
   * Height below which flipping to the opposite side is worthwhile. Defaults to 200, which is right
   * for a picker but makes a short context menu flip for no reason — pass the menu's real height.
   */
  minHeight?: number;
  /**
   * Keep at least minHeight even when neither side of the anchor has enough room, clamped to the
   * viewport. Use only for compact controls whose contents must never scroll (the date picker);
   * placement may overlap the anchor rather than clipping the control.
   */
  preserveMinHeight?: boolean;
  /** Viewport override. Defaults to the window; tests pass a fixed box instead of resizing it. */
  viewport?: { width: number; height: number };
};

/** The resolved box, so callers can derive submenu direction without re-parsing CSS strings. */
export type AnchoredPanelBox = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  /** True when the panel could not take its preferred side and was placed opposite. */
  flipped: boolean;
};

/** Smallest usable panel height. Below this we flip to the opposite side rather than squeeze. */
const MIN_USABLE_HEIGHT = 200;
/**
 * Normalise any anchor into a viewport-space rect.
 *
 * The discrimination order is load-bearing: element first (only it has `getBoundingClientRect`),
 * then rect, then point. A real `DOMRect` also carries `x`/`y`, so sniffing for `x` before `top`
 * would misclassify a rect as a point and collapse it to a zero-size box.
 */
function resolveAnchor(target: AnchorTarget): { rect: AnchorRect; isPoint: boolean } {
  if (typeof (target as HTMLElement).getBoundingClientRect === "function") {
    return { rect: (target as HTMLElement).getBoundingClientRect(), isPoint: false };
  }
  if (typeof (target as AnchorRect).top === "number") {
    return { rect: target as AnchorRect, isPoint: false };
  }
  const point = target as AnchorPoint;
  return { rect: { top: point.y, bottom: point.y, left: point.x, right: point.x }, isPoint: true };
}

export function positionAnchoredPanel(
  host: HTMLElement,
  anchor: AnchorTarget,
  placement: AnchoredPanelPlacement = {},
): AnchoredPanelBox {
  const {
    side = "bottom",
    align = "start",
    width = 288,
    crossOffset = 0,
    margin = 12,
    maxHeight = 420,
    minHeight,
    preserveMinHeight = false,
    viewport,
  } = placement;
  const { rect, isPoint } = resolveAnchor(anchor);
  // A cursor has no box to clear, so a default gap would just shift the menu off the click.
  const gap = placement.gap ?? (isPoint ? 0 : 6);
  const measured = width === "measure";
  // A previous tiny-viewport pass may have applied inline safety constraints. Remove them before
  // measuring again so growing the viewport restores the panel's natural CSS width.
  if (measured) {
    host.style.removeProperty("min-width");
    host.style.removeProperty("max-width");
  }
  const requestedWidth = Math.max(1, measured ? host.offsetWidth : width);
  const viewportWidth = Math.max(1, viewport?.width ?? window.innerWidth ?? requestedWidth);
  const viewportHeight = Math.max(1, viewport?.height ?? window.innerHeight ?? maxHeight);
  const horizontalMargin = Math.min(margin, Math.max(0, (viewportWidth - 1) / 2));
  const verticalMargin = Math.min(margin, Math.max(0, (viewportHeight - 1) / 2));
  const viewportPanelWidth = Math.max(1, viewportWidth - horizontalMargin * 2);
  const viewportPanelHeight = Math.max(1, viewportHeight - verticalMargin * 2);

  // Never inflate a narrow menu, and never preserve a minimum that is wider than the viewport.
  const panelWidth = Math.min(requestedWidth, viewportPanelWidth);

  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

  let left: number;
  let top: number;
  let available: number;
  let pinAbove = false;
  let flipped: boolean;

  if (side === "right") {
    // Main axis is horizontal: sit beside the anchor, flip to its other side when there is no room.
    const spaceRight = viewportWidth - rect.right - gap - margin;
    const spaceLeft = rect.left - gap - margin;
    flipped = spaceRight < panelWidth && spaceLeft > spaceRight;
    left = clamp(
      flipped ? rect.left - gap - panelWidth : rect.right + gap,
      horizontalMargin,
      viewportWidth - panelWidth - horizontalMargin,
    );

    available = Math.min(maxHeight, viewportPanelHeight);
    const anchorHeight = rect.bottom - rect.top;
    const preferredTop =
      align === "end"
        ? rect.bottom - available
        : align === "center"
          ? rect.top + anchorHeight / 2 - available / 2
          : rect.top;
    top = clamp(preferredTop + crossOffset, verticalMargin, viewportHeight - available - verticalMargin);
  } else {
    // Main axis is vertical. Open on the preferred side when a usable panel fits, otherwise flip.
    // Either way the result is clamped so a tall panel scrolls internally instead of clipping.
    const spaceBelow = viewportHeight - rect.bottom - gap - verticalMargin;
    const spaceAbove = rect.top - gap - verticalMargin;
    const flipThreshold = Math.min(maxHeight, minHeight ?? MIN_USABLE_HEIGHT);
    const above =
      side === "top"
        ? !(spaceAbove < flipThreshold && spaceBelow > spaceAbove)
        : spaceBelow < flipThreshold && spaceAbove > spaceBelow;
    flipped = above !== (side === "top");
    // minHeight controls when to flip; it is not a hard rendered minimum. If neither side has that
    // much room, shrink to the chosen side and let the panel scroll instead of overlapping its anchor.
    const sideSpace = Math.max(0, above ? spaceAbove : spaceBelow);
    const required = preserveMinHeight ? Math.min(minHeight ?? 1, maxHeight) : 1;
    available = Math.max(1, Math.min(viewportPanelHeight, maxHeight, Math.max(required, sideSpace)));
    top = above
      ? Math.max(verticalMargin, rect.top - gap - available)
      : Math.min(rect.bottom + gap, Math.max(verticalMargin, viewportHeight - available - verticalMargin));
    // A natural-height control may need to overlap its trigger to remain wholly on-screen. In that
    // case the clamped top is authoritative; bottom-pinning it back to the trigger would push its
    // top outside the viewport again.
    pinAbove = above && !(preserveMinHeight && available > spaceAbove);

    const anchorWidth = rect.right - rect.left;
    const preferredLeft =
      align === "end"
        ? rect.right - panelWidth
        : align === "center"
          ? rect.left + anchorWidth / 2 - panelWidth / 2
          : rect.left;
    left = clamp(preferredLeft + crossOffset, horizontalMargin, viewportWidth - panelWidth - horizontalMargin);
  }

  host.style.setProperty("--ap-left", `${Math.round(left)}px`);
  host.style.setProperty("--ap-top", `${Math.round(top)}px`);
  host.style.setProperty("--ap-max-height", `${Math.round(available)}px`);
  host.style.setProperty("--ap-max-width", `${Math.round(viewportPanelWidth)}px`);
  if (measured && requestedWidth <= viewportPanelWidth) {
    // A measured panel's component CSS owns its natural min/max width. Leaving a viewport-sized
    // inline maximum here would outrank that authored cap and let compact menus grow to max-content.
    host.style.removeProperty("max-width");
  } else host.style.setProperty("max-width", `${Math.round(viewportPanelWidth)}px`);
  if (requestedWidth > viewportPanelWidth) host.style.setProperty("min-width", "0");
  else if (!measured) host.style.removeProperty("min-width");
  // `measure` panels size from their own CSS, so publishing a width would override it.
  if (measured) host.style.removeProperty("--ap-width");
  else host.style.setProperty("--ap-width", `${Math.round(panelWidth)}px`);

  // When placed above, anchor from the bottom instead so a panel shorter than `--ap-max-height` hugs
  // its trigger rather than floating a gap away from it. `--ap-top` keeps its original meaning for
  // panels that still position from the top.
  if (pinAbove) {
    host.style.setProperty("--ap-bottom", `${Math.round(Math.max(verticalMargin, viewportHeight - rect.top + gap))}px`);
    host.classList.add("is-above");
  } else {
    host.style.removeProperty("--ap-bottom");
    host.classList.remove("is-above");
  }

  // Panels render hidden until placed, so the first paint never flashes at the top-left corner.
  host.classList.add("is-positioned");

  return { left: Math.round(left), top: Math.round(top), width: Math.round(panelWidth), maxHeight: Math.round(available), flipped };
}

/**
 * The `:host` half of the placement contract, on its own so a popover with its own panel chrome can
 * adopt placement without adopting `.ap-panel`'s look.
 *
 * Every consumer must render hidden until `positionAnchoredPanel` adds `.is-positioned`, or the first
 * paint flashes at the viewport's top-left corner.
 */
export const ANCHORED_HOST_STYLES = `
  :host {
    position: fixed;
    top: var(--ap-top, 0);
    left: var(--ap-left, 0);
    z-index: var(--z-panel, 300);
    width: var(--ap-width, 288px);
    max-width: var(--ap-max-width, calc(100vw - 24px));
    max-height: var(--ap-max-height, 420px);
    box-sizing: border-box;
    visibility: hidden;
    overflow: auto;
    overscroll-behavior: contain;
  }

  /* Flipped above the anchor: pin the bottom edge so a short panel hugs its trigger. */
  :host(.is-above) {
    top: auto;
    bottom: var(--ap-bottom, auto);
  }

  :host(.is-positioned) { visibility: visible; }
`;

/**
 * Shared chrome for anchored popover panels. Imported into a component's `styles` array so every
 * popover shares the same placement contract, radius and elevation.
 *
 * The mobile bottom-sheet fallback is deliberately *not* in here — see `ANCHORED_SHEET_STYLES`.
 */
export const ANCHORED_PANEL_STYLES = `
  ${ANCHORED_HOST_STYLES}

  .ap-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: var(--ap-max-height, 420px);
    padding: 10px;
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg, 0 8px 32px rgb(0 0 0 / 25%));
  }

  .ap-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }

  .ap-title {
    flex: 1;
    min-width: 0;
    color: var(--text);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .ap-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 26px;
    height: 26px;
    padding: 0;
    color: var(--text-muted);
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;

    &:hover { color: var(--text); background: var(--surface-2); }
  }

`;

/**
 * Opt-in phone bottom-sheet fallback, appended after `ANCHORED_PANEL_STYLES`.
 *
 * Only worth it for content-heavy panels (pickers, create forms) where a trigger near the edge of a
 * phone screen would otherwise open something cramped. It is deliberately separate rather than baked
 * into `ANCHORED_PANEL_STYLES`: applied wholesale it would turn every four-item context menu into a
 * full-width sheet, which reads as a bug. `:host(.is-above)` is listed explicitly so the sheet still
 * outranks the flip-above rule, which is equally specific.
 */
export function anchoredSheetStyles(panelClass = "ap-panel"): string {
  return `
  @media (max-width: 560px) {
    :host,
    :host(.is-above) {
      top: auto;
      right: 8px;
      /* The sheet sat under the iOS home indicator, which is exactly where a picker's last rows are. */
      bottom: max(8px, calc(env(safe-area-inset-bottom) + 8px));
      left: 8px;
      width: auto;
    }

    /* dvh, not vh: a phone's collapsing URL bar otherwise sizes the sheet to a viewport taller than
       the one it is actually being shown in. */
    .${panelClass} { max-height: min(70dvh, 480px); }
  }
`;
}

export const ANCHORED_SHEET_STYLES = anchoredSheetStyles();

/**
 * Compact text input for popover panels (`class="ap-input"`).
 *
 * The `:host` prefix is load-bearing, not decoration. The global reset in styles.scss
 * (`input:not([type=checkbox]):not([type=radio])`) has higher specificity than a bare class, so a
 * plain `.xx-input` rule loses its height/padding to the 36px app input and — the visible bug —
 * keeps the global accent focus ring while its own rule recolours the border to a neutral tone,
 * which reads as a mismatched double highlight. Scoping through the host outranks the reset and
 * lets focus look like every other input in the app: accent border plus the shared ring.
 */
export const PANEL_INPUT_STYLES = `
  :host .ap-input {
    width: 100%;
    height: auto;
    min-height: 34px;
    padding: 6px 9px;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  :host .ap-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--ring);
  }
`;
