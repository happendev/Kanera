// Prefer the pointer media query, but keep maxTouchPoints as a fallback for
// browsers/environments that expose touch capability without matchMedia support.
export function hasCoarsePointer(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) return true;
  return typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
}
