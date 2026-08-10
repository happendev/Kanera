import { CdkTrapFocus } from "@angular/cdk/a11y";
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { BodyScrollLockService } from "../../shared/body-scroll-lock.service";
import { PriorityQueueComponent } from "../../shared/priority-queue/priority-queue.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { isDueSoon, isOverdue } from "../board/due-date.util";

/** How long the close animation runs; the drawer unmounts after it. Matches the notifications drawer. */
const CLOSE_ANIMATION_MS = 110;

/**
 * "Up next" as shell chrome: the viewer's own priority queue, one click from any page.
 *
 * Sits beside the notifications bell and behaves like it — a fixed circular trigger with a count
 * badge, a right-hand drawer with a backdrop, escape to close, and no stale data offline. The two
 * are the app's only always-reachable personal surfaces, so they deliberately share a shape: one is
 * "what happened", this is "what's next".
 *
 * It owns no queue state. Everything comes from `MyPrioritiesService`, which the My Cards dock and
 * Home's block also read, so a reorder made here is already correct on those surfaces the moment it
 * settles — there is no second copy to converge.
 */
@Component({
  selector: "k-my-priorities-panel",
  standalone: true,
  imports: [CdkTrapFocus, PriorityQueueComponent, RouterLink, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./my-priorities-panel.component.html",
  styleUrl: "./my-priorities-panel.component.scss",
})
export class MyPrioritiesPanelComponent {
  private readonly priorities = inject(MyPrioritiesService);
  private readonly router = inject(Router);
  private readonly bodyScrollLock = inject(BodyScrollLockService);

  readonly open = signal(false);
  readonly closing = signal(false);
  /** One clock reading shared by the strip and every row for the whole open drawer session. */
  readonly dueReferenceTime = signal(Date.now());

  readonly queue = this.priorities.queue;
  readonly items = this.priorities.items;
  readonly totalCount = this.priorities.totalCount;
  readonly loading = this.priorities.loading;
  readonly loadError = this.priorities.loadError;
  readonly online = this.priorities.online;
  readonly addableCards = this.priorities.addableCards;
  readonly changedSinceSeen = this.priorities.changedSinceSeen;

  /** Errors from drawer gestures render inside the drawer, above the row that failed. */
  readonly actionError = signal<string | null>(null);

  /** Nothing queued, but there is work that could be — the one case worth a "here's how" nudge. */
  readonly showEmptyWithWork = computed(
    () => this.items().length === 0 && this.addableCards().length > 0,
  );
  /** The first load, before anything has ever arrived: a skeleton, not an empty state. */
  readonly showSkeleton = computed(() => this.loading() && this.queue() === null);
  readonly showRows = computed(() => this.online() && this.items().length > 0);

  /**
   * How much of the queue is under time pressure, for the strip above the rows. The queue is an
   * order — that is the point — but an overdue card at rank 12 is below the fold with nothing saying
   * so, and this is the one fact worth stating before the reader scrolls.
   *
   * Counted with *exactly* the two predicates the rows colour their due chips with, so "2 overdue"
   * is the number of red chips below it and the strip is arithmetically verifiable. Deliberately not
   * the app's `today` bucket vocabulary: that bucket is a calendar-day comparison, while these chips
   * follow the slot-*instant* rule, so a card due today at `morning` read at 14:00 is red and
   * "today" at the same time. A header saying "3 due today" over a red row would be provably wrong.
   *
   * No clock ticker, deliberately. Ticking *this* alone would be worse than not ticking at all: it
   * would flip a card to "overdue" while the chip beneath it stayed amber, because `dueOverdue` on
   * the row is a template method re-evaluated only on change detection. Consistent staleness beats
   * inconsistent freshness, and the drawer recomputes on open, on reconnect, on every snapshot and
   * after every gesture. If it ever needs to be live, the fix is a shared `dueClockTick` signal in
   * `due-date.util.ts` that both this and the row read — not a timer here.
   *
   * `null` when both are zero so the template gates on one check.
   */
  readonly duePressure = computed<{ overdue: number; dueSoon: number } | null>(() => {
    const now = new Date(this.dueReferenceTime());
    let overdue = 0;
    let dueSoon = 0;
    for (const item of this.items()) {
      const card = item.card;
      // A redacted entry discloses nothing to count, and a completed or archived card carries no due
      // pressure — the same guard the row's own chip applies.
      if (!card || card.completedAt || card.archivedAt) continue;
      const localDate = card.dueDateLocalDate ?? null;
      const slot = card.dueDateSlot ?? null;
      const timezone = card.dueDateTimezone ?? null;
      // Disjoint by construction (overdue is `now >= due`, due-soon is `now < due`), so no card is
      // counted twice.
      if (isOverdue(localDate, slot, timezone, now)) overdue += 1;
      else if (isDueSoon(localDate, slot, timezone, now)) dueSoon += 1;
    }
    return overdue === 0 && dueSoon === 0 ? null : { overdue, dueSoon };
  });

  private drawerWasOffline = false;

  constructor() {
    // The shell mounts this once, so this is also where the app-wide queue starts listening.
    this.priorities.initialise();
    effect((onCleanup) => {
      if (!this.open()) return;
      onCleanup(this.bodyScrollLock.acquire());
    });
    // Reconnecting with the drawer open must repaint it, not leave an offline notice over live data.
    effect(() => {
      if (!this.open()) {
        this.drawerWasOffline = false;
        return;
      }
      if (!this.online()) {
        this.drawerWasOffline = true;
        return;
      }
      if (this.drawerWasOffline) {
        this.drawerWasOffline = false;
        void this.priorities.refresh();
        void this.priorities.loadAddCandidates();
      }
    });
    // Continuously while open, not just on toggle: a change that lands under an open drawer has been
    // seen, and must not pulse the trigger the moment it closes.
    effect(() => {
      if (!this.open()) return;
      // Read the items so this re-runs as the queue changes.
      this.items();
      this.priorities.markSeen();
    });
  }

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.actionError.set(null);
    this.closing.set(false);
    // A computed cannot observe wall-clock time. Refresh this dependency explicitly on each open so
    // a cached pressure summary and the newly-rendered row classes always evaluate the same instant.
    this.dueReferenceTime.set(Date.now());
    this.open.set(true);
    void this.priorities.refresh();
    // The candidate pool is two requests nobody who never opens this drawer should pay for.
    void this.priorities.loadAddCandidates();
  }

  close(): void {
    if (!this.open() || this.closing()) return;
    this.closing.set(true);
    setTimeout(() => {
      this.open.set(false);
      this.closing.set(false);
    }, CLOSE_ANIMATION_MS);
  }

  @HostListener("document:keydown.escape")
  onEscape(): void {
    if (this.open()) this.close();
  }

  retry(): void {
    void this.priorities.refresh();
    void this.priorities.loadAddCandidates();
  }

  /**
   * Open the card behind a row. Routed as `/b/:boardId/c/:cardId` with the shareable `/o/…/c/KEY`
   * form as the displayed URL — the same pattern Home and the notifications drawer use, so a card
   * opened from anywhere has one address.
   */
  openCard(event: { cardId: string; boardId: string; event: MouseEvent }): void {
    const browserUrl = this.priorities.cardBrowserUrl(event.cardId);
    // Middle-click and ⌘/Ctrl-click keep their new-tab meaning, as on every card surface — and the
    // drawer stays open, because the reader is collecting tabs rather than leaving.
    const wantsNewTab = event.event.button === 1 || event.event.metaKey || event.event.ctrlKey;
    if (wantsNewTab && browserUrl) {
      window.open(browserUrl, "_blank", "noopener");
      return;
    }
    this.close();
    void this.router.navigate(["/b", event.boardId, "c", event.cardId], {
      ...(browserUrl ? { browserUrl } : {}),
    });
  }

  onReordered(event: { priorityId: string; afterId?: string | null; beforeId?: string | null }): void {
    this.actionError.set(null);
    const { priorityId, ...anchor } = event;
    void this.priorities.movePriority(priorityId, anchor).catch(() => {
      this.actionError.set("We couldn’t reorder that card. Its previous position has been restored.");
    });
  }

  onRemoved(event: { priorityId: string }): void {
    this.actionError.set(null);
    void this.priorities.removePriority(event.priorityId).catch(() => {
      this.actionError.set("We couldn’t remove that card from Up next. It has been put back.");
    });
  }

  onAdded(event: { cardId: string; afterId?: string | null; beforeId?: string | null }): void {
    this.actionError.set(null);
    const { cardId, ...anchor } = event;
    void this.priorities.addPriority(cardId, anchor).catch(() => {
      this.actionError.set("We couldn’t add that card to Up next. Nothing has changed.");
    });
  }

  onCompleted(event: { cardId: string; completed: boolean }): void {
    this.actionError.set(null);
    void this.priorities.setCardCompleted(event.cardId, event.completed).catch(() => {
      this.actionError.set("We couldn’t update that card. Nothing has changed.");
    });
  }
}
