import { hasCoarsePointer } from "./input-modality";

const CARD_DRAG_START_PATTERN = 12;
const CARD_DRAG_END_PATTERN = [8, 24, 8] as const;

function vibrate(pattern: VibratePattern): void {
  // Keep haptics touch-only; desktop browsers may expose the API but should not
  // buzz during mouse drag interactions.
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function" || !hasCoarsePointer()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Vibration support varies across mobile browsers; tactile feedback is optional.
  }
}

export function vibrateCardDragStart(): void {
  vibrate(CARD_DRAG_START_PATTERN);
}

export function vibrateCardDragEnd(): void {
  vibrate([...CARD_DRAG_END_PATTERN]);
}
