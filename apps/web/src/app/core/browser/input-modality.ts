// Prefer the pointer media query, but keep maxTouchPoints as a fallback for
// browsers/environments that expose touch capability without matchMedia support.
export function hasCoarsePointer(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) return true;
  return typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
}

/**
 * Matches phones and tablets driven by touch alone: no mouse or trackpad attached. Keyboard-shortcut
 * affordances (the shortcuts sheet, its menu entry, key hints) are hidden under it, since there is no
 * physical keyboard to press them on. Deliberately not hasCoarsePointer(): touchscreen laptops and
 * iPads with a trackpad keyboard also report a hovering pointer, and those users do have keys.
 * Phrased with `any-hover` rather than `not (any-pointer: fine)` because older Safari rejects `not`
 * inside a media condition and would then match nothing.
 * styles.scss repeats this query to hide `.k-kbd` hints; keep the two in step.
 */
export const TOUCH_ONLY_QUERY = "(any-hover: none) and (pointer: coarse)";
