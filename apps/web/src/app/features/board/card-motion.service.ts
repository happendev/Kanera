import { Injectable } from "@angular/core";

const LANDING_CLASS = "is-landing";
// Matches the card-land animation in card.component.scss.
const LANDING_MS = 800;

/**
 * The landing wash: a card arrived somewhere the eye did not follow it (a drop, or another person's
 * move or new card), so its tile washes once to say "it is here now".
 *
 * Root-scoped because a drop or a realtime move destroys the tile in its source list and creates a
 * new one in the target list. Tiles register their host element and the class is toggled on the
 * DOM directly: a signal read by every tile would re-check every lane on the board at the moment of
 * a drop, the most latency-sensitive frame there is, just to change one tile.
 */
@Injectable({ providedIn: "root" })
export class CardMotionService {
  private readonly tiles = new Map<string, Set<HTMLElement>>();
  // Cards whose next tile should still wash, until the window closes.
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settling = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

  /**
   * `pickupMs` is how long a tile created after this call still washes. A drop or an applied move
   * renders within a frame; a card that only appears after a refetch needs the round trip.
   */
  land(cardIds: Iterable<string>, pickupMs = LANDING_MS): void {
    for (const cardId of cardIds) {
      const open = this.pending.get(cardId);
      if (open !== undefined) clearTimeout(open);
      this.pending.set(cardId, setTimeout(() => this.pending.delete(cardId), pickupMs));
      for (const tile of this.tiles.get(cardId) ?? []) this.wash(tile);
    }
  }

  /** A tile created while its card is landing (the cross-list case) picks the wash up here. */
  attach(cardId: string, tile: HTMLElement): () => void {
    let tiles = this.tiles.get(cardId);
    if (!tiles) this.tiles.set(cardId, (tiles = new Set()));
    tiles.add(tile);
    if (this.pending.has(cardId)) this.wash(tile);
    return () => {
      tiles.delete(tile);
      if (tiles.size === 0) this.tiles.delete(cardId);
      this.settle(tile);
    };
  }

  // Each tile times its own wash, so one that picked the mark up late still plays it in full.
  private wash(tile: HTMLElement): void {
    if (this.settling.has(tile)) return;
    tile.classList.add(LANDING_CLASS);
    this.settling.set(tile, setTimeout(() => this.settle(tile), LANDING_MS));
  }

  private settle(tile: HTMLElement): void {
    const timer = this.settling.get(tile);
    if (timer !== undefined) clearTimeout(timer);
    this.settling.delete(tile);
    tile.classList.remove(LANDING_CLASS);
  }
}
