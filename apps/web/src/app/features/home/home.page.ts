import type { OnInit } from "@angular/core";
import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import type { HomeDueBucket, HomeItem } from "@kanera/shared/dto";
import { AuthService } from "../../core/auth/auth.service";
import { RecentBoardsService } from "../../core/recent-boards/recent-boards.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ActivityStripComponent, type ActivityStripSeries } from "../../shared/activity-strip.component";
import { mediaQuerySignal } from "../../shared/media-query.signal";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { StatTileComponent } from "../../shared/stat-tile.component";
import { BoardMenuCoordinator } from "../board/board-menu-coordinator.service";
import { AgendaGroupComponent } from "./agenda-group.component";
import { HomeState } from "./home.state";

/**
 * Trend window, and the narrow-viewport window.
 *
 * 28 halves cleanly to 14, so both are whole weeks and the strip's Monday markers stay aligned.
 * At 320px, 28 cells with a 2px gap are already ~9px wide; 56 would be untappable.
 * Canonical definition: HOME_TREND_DAYS in packages/shared/src/dto/home.ts (not imported, because
 * the web bundle only takes types from that package — its runtime entry pulls in zod).
 */
const TREND_DAYS = 28;
const TREND_DAYS_NARROW = 14;

/** Matches MOBILE_BREAKPOINT in app-shell, where the sidebar itself moves behind a drawer. */
const NARROW_QUERY = "(max-width: 640px)";

@Component({
  selector: "k-home",
  standalone: true,
  imports: [ActivityStripComponent, AgendaGroupComponent, DatePipe, PageHeaderComponent, RouterLink, StatTileComponent],
  // BoardMenuCoordinator owns the shared "labels compressed" preference that k-card-labels reads.
  // It is deliberately not root-provided (it holds document listeners), so every surface rendering
  // board chips provides it — same as GlobalWorkPage.
  providers: [HomeState, BoardMenuCoordinator],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./home.page.html",
  styleUrls: ["../../shared/page-styles.scss", "./home.page.scss"],
})
export class HomePage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly recentBoardsService = inject(RecentBoardsService);
  private readonly router = inject(Router);
  private readonly workspaceService = inject(WorkspaceService);

  readonly state = inject(HomeState);

  readonly isOrgAdmin = this.auth.isOrgAdmin;
  /** Placeholder rows for the loading skeleton; the count only has to look like the real layout. */
  readonly skeletonRows = [0, 1, 2, 3];
  readonly skeletonTiles = [0, 1, 2, 3];

  readonly displayName = computed(() => this.auth.user()?.displayName ?? "");
  readonly today = signal(new Date());

  /**
   * The onboarding empty state keys off the account, not off loaded data.
   *
   * Gating on "no items" would show it to an established user having a quiet week; `hasWorkspace`
   * is the same flag onboarding itself runs on.
   */
  readonly hasNoWorkspace = computed(() => this.auth.user()?.hasWorkspace === false);

  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  });

  // Trial status drives the banner. tier === "trial" only ever happens in hosted mode; for
  // self-hosted / paid orgs these stay false/null and the banner is hidden.
  readonly isTrial = computed(() => this.auth.entitlements()?.tier === "trial");
  readonly trialEndsAt = computed(() => {
    const iso = this.auth.entitlements()?.trialEndsAt ?? null;
    return iso ? new Date(iso) : null;
  });
  readonly trialDaysLeft = computed(() => {
    const end = this.trialEndsAt();
    if (!end) return 0;
    return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
  });

  readonly boardLimitReached = computed(() => {
    const max = this.auth.maxBoards();
    return max !== null && this.state.boardCount() >= max;
  });
  readonly workspaceCreateAttempted = signal(false);
  readonly workspaceCreateLimitMessage = computed(() => {
    if (!this.workspaceCreateAttempted() || !this.boardLimitReached()) return null;
    const max = this.auth.maxBoards();
    return max === null
      ? "Your plan's board limit has been reached."
      : `Your plan allows ${max} board${max === 1 ? "" : "s"}. Upgrade to add another workspace.`;
  });

  /**
   * Recently-viewed boards, resolved through WorkspaceService rather than a payload field.
   *
   * The shell registers every own and guest board before this child route renders, including on
   * the offline path, so this is reactive, works offline, and keeps the endpoint free of a board
   * index. This strip is a different affordance from the sidebar: the sidebar is a directory in
   * position order, this is most-recently-used.
   */
  readonly recentBoards = computed(() =>
    this.recentBoardsService.boardIds()
      .map((id) => {
        const summary = this.workspaceService.boardSummaryFor(id);
        return summary ? { id, ...summary } : null;
      })
      .filter((board): board is { id: string; name: string; icon: string | null; iconColor: string | null } => !!board)
      .slice(0, 5));

  /**
   * Which focus tile is engaged, filtering the agenda below.
   *
   * The tiles used to scroll to the agenda, which on a page this short was usually already on
   * screen — so they looked clickable and appeared to do nothing. Filtering is a visible response
   * every time. "upcoming" is the Next-7-days tile: every dated bucket except overdue.
   */
  readonly focusFilter = signal<HomeDueBucket | "upcoming" | null>(null);

  readonly visibleGroups = computed(() => {
    const filter = this.focusFilter();
    const groups = this.state.groups();
    if (!filter) return groups;
    if (filter === "upcoming") return groups.filter((group) => group.bucket !== "overdue");
    return groups.filter((group) => group.bucket === filter);
  });

  readonly focusFilterLabel = computed(() => {
    const filter = this.focusFilter();
    if (!filter) return null;
    if (filter === "upcoming") return "the next 7 days";
    return filter === "overdue" ? "overdue work" : filter === "today" ? "today" : "tomorrow";
  });

  /** Narrow viewports halve the trend window; see TREND_DAYS_NARROW. */
  private readonly narrow = mediaQuerySignal(NARROW_QUERY);
  readonly visibleTrendDays = computed(() => (this.narrow() ? TREND_DAYS_NARROW : TREND_DAYS));

  /**
   * A single completion series. Cards and checklist items are summed rather than split into two
   * rows: home answers "am I keeping up", not "what kind of thing did I finish".
   */
  readonly trendSeries = computed<ActivityStripSeries[]>(() => [{
    key: "completed",
    label: "Completed",
    noun: "item",
    tone: "success",
    counts: new Map(this.state.trend().byDay.map((day) => [
      day.date,
      day.completedCards + day.completedChecklistItems,
    ])),
  }]);

  ngOnInit(): void {
    void this.state.initialize();
  }

  /** Focus tiles toggle: clicking the engaged one clears the filter rather than dead-ending. */
  toggleFocus(filter: HomeDueBucket | "upcoming"): void {
    this.focusFilter.update((current) => (current === filter ? null : filter));
  }

  clearFocus(): void {
    this.focusFilter.set(null);
  }

  openItem(item: HomeItem): void {
    // Checklist items have no route of their own; `cardId` is always the card to deep-link to.
    void this.router.navigate(["/b", item.boardId], { queryParams: { cardId: item.cardId } });
  }

  openBoard(boardId: string): void {
    void this.router.navigate(["/b", boardId]);
  }

  newWorkspace(): void {
    if (this.boardLimitReached()) {
      this.workspaceCreateAttempted.set(true);
      return;
    }
    this.workspaceCreateAttempted.set(false);
    void this.router.navigateByUrl("/onboarding?mode=workspace");
  }
}
