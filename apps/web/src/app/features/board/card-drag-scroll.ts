import { hasCoarsePointer } from "../../core/browser/input-modality";

export const EDGE_SCROLL_THRESHOLD = 96;
export const MAX_EDGE_SCROLL_STEP = 28;
export const MOBILE_EDGE_SCROLL_STEP = 6;

// Long-press gate on touch: a finger must hold a card this long (without moving past CDK's
// dragStartThreshold) before a drag begins, so a normal swipe scrolls the list instead of
// dragging. Mouse stays at 0 so desktop drag is immediate. vibrateCardDragStart() in
// onDragStarted fires only after this delay, giving the "hold → buzz → drag" feel.
export const CARD_DRAG_START_DELAY = { touch: 600, mouse: 0 } as const;

// Board and Assigned Work share card drag auto-scroll. Touch dragging uses a
// fixed slow step so the board does not accelerate away from the user's finger.
export function cardDragEdgeScrollStep(position: number, viewportSize: number): number {
  if (position < EDGE_SCROLL_THRESHOLD) {
    return -cardDragEdgeScrollSpeed(EDGE_SCROLL_THRESHOLD - position);
  }
  if (position > viewportSize - EDGE_SCROLL_THRESHOLD) {
    return cardDragEdgeScrollSpeed(position - (viewportSize - EDGE_SCROLL_THRESHOLD));
  }
  return 0;
}

function cardDragEdgeScrollSpeed(distanceIntoEdge: number): number {
  if (hasCoarsePointer()) return MOBILE_EDGE_SCROLL_STEP;
  // Mouse users can intentionally push deeper into the edge zone for faster
  // travel across wide boards.
  const ratio = Math.min(1, Math.max(0, distanceIntoEdge / EDGE_SCROLL_THRESHOLD));
  return Math.ceil(ratio * MAX_EDGE_SCROLL_STEP);
}
