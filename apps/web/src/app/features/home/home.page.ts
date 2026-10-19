import { EmptyStateComponent } from "../../shared/empty-state.component";
import type { OnInit } from "@angular/core";
import { Dialog } from "@angular/cdk/dialog";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { cardPath } from "@kanera/shared/card-links";
import type { BillingDowngradePreviewResponse, HomeDueBucket, HomeItem } from "@kanera/shared/dto";
import { AnalyticsService } from "../../core/analytics/analytics.service";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { describeAcceptInvitationError, PendingInvitationsService } from "../../core/board-invitations/pending-invitations.service";
import { MyPrioritiesService } from "../../core/priorities/my-priorities.service";
import { RecentBoardsService } from "../../core/recent-boards/recent-boards.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { ActivityStripComponent, type ActivityStripSeries } from "../../shared/activity-strip.component";
import { AgentConnectCardComponent } from "../../shared/agent-connect-card/agent-connect-card.component";
import { mediaQuerySignal } from "../../shared/media-query.signal";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { StatTileComponent } from "../../shared/stat-tile.component";
import { UpgradePromptService } from "../../shared/upgrade-prompt.service";
import { BoardMenuCoordinator } from "../board/board-menu-coordinator.service";
import { PriorityQueueComponent } from "../../shared/priority-queue/priority-queue.component";
import { StandaloneBoardCreateDialogComponent } from "../standalone-board/standalone-board-create.dialog";
import { AgendaGroupComponent } from "./agenda-group.component";
import { GettingStartedComponent } from "./getting-started.component";
import { UpcomingRemindersComponent } from "./upcoming-reminders.component";
import { HomeState } from "./home.state";
import { icu } from "../../core/i18n/icu";
import { formatDate, formatTime } from "../../shared/date-format";

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

type AccountStatusBanner = {
  kind: "free" | "trial" | "paid" | "pastDue" | "selfHosted";
  tone: "neutral" | "accent" | "success" | "danger";
  statusLabel: string;
  title: string;
  description: string;
  actionLabel: string;
};

type ScatterKind = "ring" | "dash" | "square" | "dot" | "arc" | "check";
interface ScatterItem { kind: ScatterKind; x: number; y: number; size: number; rotate?: number; accent: "teal" | "sky" | "indigo" }

const HERO_SCATTER: readonly ScatterItem[] = [
  { kind: "ring", x: 52, y: 8, size: 12, accent: "teal" },
  { kind: "dash", x: 60, y: 30, size: 30, rotate: -24, accent: "sky" },
  { kind: "dot", x: 56, y: 62, size: 6, accent: "indigo" },
  { kind: "check", x: 66, y: 74, size: 16, rotate: -8, accent: "teal" },
  { kind: "square", x: 72, y: 14, size: 14, rotate: 18, accent: "indigo" },
  { kind: "arc", x: 78, y: 52, size: 20, rotate: 160, accent: "sky" },
  { kind: "dot", x: 84, y: 26, size: 7, accent: "teal" },
  { kind: "dash", x: 88, y: 78, size: 26, rotate: 20, accent: "indigo" },
  { kind: "ring", x: 93, y: 10, size: 9, accent: "sky" },
  { kind: "check", x: 96, y: 44, size: 14, rotate: 10, accent: "sky" },
  { kind: "dot", x: 98, y: 88, size: 5, accent: "teal" },
  { kind: "square", x: 63, y: 92, size: 10, rotate: -12, accent: "teal" },
];

@Component({
  selector: "k-home",
  standalone: true,
  imports: [ActivityStripComponent, EmptyStateComponent, AgendaGroupComponent, AgentConnectCardComponent, GettingStartedComponent, PageHeaderComponent, PriorityQueueComponent, RouterLink, StatTileComponent, UpcomingRemindersComponent],
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
  private readonly analytics = inject(AnalyticsService);
  private readonly api = inject(ApiClient);
  private readonly dialog = inject(Dialog);
  readonly invitations = inject(PendingInvitationsService);
  readonly myPriorities = inject(MyPrioritiesService);
  private readonly recentBoardsService = inject(RecentBoardsService);
  private readonly router = inject(Router);
  private readonly workspaceService = inject(WorkspaceService);
  private readonly upgradePrompt = inject(UpgradePromptService);

  readonly state = inject(HomeState);

  readonly isOrgAdmin = this.auth.isOrgAdmin;

  /**
   * The decorative shapes behind the greeting. Positions are percentages of the hero box and are
   * kept to the right of ~45%, where the greeting and date never reach, plus a few at the far left
   * edge that sit outside the reading column's text. Same vocabulary as the marketing site's hero.
   */
  readonly scatter = HERO_SCATTER;
  /** Placeholder rows for the loading skeleton; the count only has to look like the real layout. */
  readonly skeletonRows = [0, 1, 2, 3];
  readonly skeletonTiles = [0, 1, 2, 3];

  readonly displayName = computed(() => this.auth.user()?.displayName ?? "");
  readonly today = signal(new Date());
  readonly acceptingInvitationId = signal<string | null>(null);
  readonly invitationError = signal<string | null>(null);

  /**
   * Whether the account has a *standard* workspace. Only used for empty-state copy, never to decide
   * whether home renders: `hasWorkspace` excludes standalone boards and cross-organisation guest
   * boards, so a user with either would have been sent to a lock icon while holding real work.
   */
  readonly hasNoWorkspace = computed(() => this.auth.user()?.hasWorkspace === false);

  /**
   * The getting-started empty state keys off accessible boards, not off the workspace flag.
   *
   * `boardCount` is the server's count of every board the viewer can open — workspace, standalone,
   * and guest — so this is true only when there is genuinely nothing to work in. It is read after
   * the loading and error branches, because an unloaded payload also counts zero.
   */
  readonly hasNoBoards = computed(() => this.state.boardCount() === 0);

  /** The page title: a time-of-day greeting with the viewer's name, as one message per greeting. */
  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    const name = this.displayName();
    if (hour < 12) return icu($localize`:Home page greeting before noon:Good morning, {name}`, { name });
    if (hour < 18) return icu($localize`:Home page greeting in the afternoon:Good afternoon, {name}`, { name });
    return icu($localize`:Home page greeting in the evening:Good evening, {name}`, { name });
  });
  /** "Wednesday, 4 March 2026" style, in the viewer's language. */
  readonly todayLabel = computed(() => formatDate(this.today(), "long"));
  readonly trialEndsLabel = computed(() => formatDate(this.trialEndsAt(), "medium"));

  /** Wall-clock time for the offline banners. */
  formatTime(value: Date | string | number | null | undefined): string {
    return formatTime(value);
  }

  readonly trialEndsAt = computed(() => {
    const iso = this.auth.entitlements()?.trialEndsAt ?? null;
    return iso ? new Date(iso) : null;
  });
  readonly trialDaysLeft = computed(() => {
    const end = this.trialEndsAt();
    if (!end) return 0;
    return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
  });
  readonly proUsage = computed(() => this.state.response().proUsage ?? null);
  readonly downgradePreview = signal<BillingDowngradePreviewResponse | null>(null);
  readonly downgradeMemberNames = computed(() => this.downgradePreview()?.members.map((member) => member.displayName).join(", ") ?? "");
  readonly downgradeBoardNames = computed(() => this.downgradePreview()?.boards.map((board) => `${board.name} (${board.workspaceName})`).join(", ") ?? "");
  readonly proUsageDetail = computed(() => {
    const usage = this.proUsage();
    if (!usage) return "";
    const parts = [
      icu($localize`:Pro usage on the trial banner:{count, plural, one {# user} other {# users}}`, { count: usage.memberCount }),
      icu($localize`:Pro usage on the trial banner:{count, plural, one {# board} other {# boards}}`, { count: usage.boardCount }),
      icu($localize`:Pro usage on the trial banner:{count, plural, one {# automation} other {# automations}}`, { count: usage.automationCount }),
      ...(usage.apiConnection ? [$localize`:Pro usage on the trial banner - the organisation has an API connection:API connection`] : []),
      ...(usage.guestCount > 0
        ? [icu($localize`:Pro usage on the trial banner:{count, plural, one {# guest} other {# guests}}`, { count: usage.guestCount })]
        : []),
    ];
    return parts.join(" · ");
  });
  readonly accountStatusBanner = computed<AccountStatusBanner | null>(() => {
    if (!this.isOrgAdmin()) return null;
    const user = this.auth.user();
    const entitlements = this.auth.entitlements();
    if (!user || !entitlements) return null;

    if (user.deploymentMode === "self_hosted") {
      return {
        kind: "selfHosted",
        tone: "neutral",
        statusLabel: $localize`:Account status label:Self-hosted`,
        title: $localize`:Account status banner title on a self-hosted deployment:Unlimited access is active`,
        description: $localize`:Account status banner on a self-hosted deployment:Your organisation's plan is managed by this Kanera deployment.`,
        actionLabel: $localize`:Link to account settings:Account settings`,
      };
    }

    if (entitlements.tier === "trial") {
      const days = this.trialDaysLeft();
      return {
        kind: "trial",
        tone: "accent",
        statusLabel: $localize`:Account status label:Pro trial`,
        title: icu($localize`:Account status banner title during a trial:Your Pro trial is active · {count, plural, one {# day} other {# days}} left`, { count: days }),
        description: $localize`:Account status banner during a trial:After the trial, your organisation moves to Kanera Free and over-limit boards remain safely stored.`,
        actionLabel: $localize`:Link to upgrade from the trial:Choose Pro`,
      };
    }

    if (entitlements.tier === "free") {
      const maxBoards = entitlements.maxBoards;
      const allowance = maxBoards === null
        ? $localize`:Account status banner on the Free plan:Free plan limits are active.`
        : icu($localize`:Account status banner on the Free plan:You can keep {count, plural, one {# board} other {# boards}} active.`, { count: maxBoards });
      const executionsRemaining = this.state.automationExecutionsRemaining();
      const automationAllowance = user.role === "owner" && executionsRemaining !== null
        ? icu($localize`:Account status banner on the Free plan:{count, plural, one {# automation execution} other {# automation executions}} left this month.`, { count: executionsRemaining })
        : null;
      // Separate sentences, joined with a space; each is translated whole.
      const description = [
        allowance,
        automationAllowance,
        $localize`:Account status banner on the Free plan:Disabled boards are safely stored and return when you upgrade.`,
      ].filter(Boolean).join(" ");
      return {
        kind: "free",
        tone: "neutral",
        statusLabel: $localize`:Account status label - the Free plan:Free`,
        title: $localize`:Account status banner title on the Free plan:Your organisation is on Kanera Free`,
        description,
        actionLabel: $localize`:Link to upgrade to the Pro plan:Upgrade to Pro`,
      };
    }

    if (entitlements.billingStatus === "past_due") {
      return {
        kind: "pastDue",
        tone: "danger",
        statusLabel: $localize`:Account status label:Payment issue`,
        title: $localize`:Account status banner title when a payment failed:Pro access is still active, but payment needs attention`,
        description: $localize`:Account status banner when a payment failed:Review your billing details to avoid a future downgrade to Kanera Free.`,
        actionLabel: $localize`:Link to billing settings:Review billing`,
      };
    }

    return {
      kind: "paid",
      tone: "success",
      statusLabel: $localize`:Account status label:Pro plan`,
      title: $localize`:Account status banner title on the Pro plan:Kanera Pro is active`,
      description: $localize`:Account status banner on the Pro plan:Your organisation has full access to boards, guests, automations, webhooks, and the API.`,
      actionLabel: $localize`:Link to plan settings:Manage plan`,
    };
  });

  readonly boardLimitReached = computed(() => {
    const max = this.auth.maxBoards();
    return max !== null && this.state.boardCount() >= max;
  });
  /** Which create button was pressed while over the plan's board cap; drives the inline message. */
  readonly createAttempted = signal<"workspace" | "board" | null>(null);
  readonly createLimitMessage = computed(() => {
    const attempted = this.createAttempted();
    if (!attempted || !this.boardLimitReached()) return null;
    const max = this.auth.maxBoards();
    if (max === null) return $localize`:Inline message when the plan's board cap is reached:Your plan's board limit has been reached.`;
    return attempted === "workspace"
      ? icu($localize`:Inline message when the plan's board cap is reached:Your plan allows {count, plural, one {# board} other {# boards}}. Upgrade to add another workspace.`, { count: max })
      : icu($localize`:Inline message when the plan's board cap is reached:Your plan allows {count, plural, one {# board} other {# boards}}. Upgrade to add another board.`, { count: max });
  });

  /**
   * Recently-viewed boards, resolved through WorkspaceService rather than a payload field.
   *
   * The shell registers every own and guest board before this child route renders, including on
   * the offline path, so this is reactive, works offline, and keeps the endpoint free of a board
   * index. This strip is a different affordance from the sidebar: the sidebar is a directory in
   * position order, this is most-recently-used.
   */
  private readonly recentlyViewedBoards = computed(() =>
    this.recentBoardsService.boardIds()
      .map((id) => {
        const summary = this.workspaceService.boardSummaryFor(id);
        return summary ? { id, ...summary } : null;
      })
      .filter((board): board is { id: string; name: string; icon: string | null; iconColor: string | null } => !!board)
      .slice(0, 5));

  /**
   * Falls back to the registered board list when there is no visit history — a first login, a new
   * device, or cleared storage. Without the fallback the strip vanished exactly when it mattered
   * most: a user whose only board is standalone got a page with no way to reach it below 640px,
   * where the sidebar is behind a drawer.
   */
  readonly recentBoards = computed(() => {
    const recents = this.recentlyViewedBoards();
    return recents.length > 0 ? recents : this.workspaceService.boards().slice(0, 5);
  });

  /** Where the checklist's card steps send people: the board they were last on. */
  readonly lastBoardId = computed(() => this.recentBoards().at(0)?.id ?? null);

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
    if (filter === "upcoming") return $localize`:Agenda filter chip - Showing ...:Showing the next 7 days`;
    if (filter === "overdue") return $localize`:Agenda filter chip - Showing ...:Showing overdue work`;
    if (filter === "today") return $localize`:Agenda filter chip - Showing ...:Showing today`;
    return $localize`:Agenda filter chip - Showing ...:Showing tomorrow`;
  });

  /** Narrow viewports halve the trend window; see TREND_DAYS_NARROW. */
  private readonly narrow = mediaQuerySignal(NARROW_QUERY);
  readonly visibleTrendDays = computed(() => (this.narrow() ? TREND_DAYS_NARROW : TREND_DAYS));

  /** Matches My Cards history: only completed cards count as completed work. */
  readonly trendSeries = computed<ActivityStripSeries[]>(() => [{
    key: "completed",
    label: $localize`:Activity strip series - cards completed:Completed`,
    noun: "card",
    countLabel: (count) => icu($localize`:Activity strip day tooltip count:{count, plural, one {# card} other {# cards}}`, { count }),
    tone: "success",
    counts: new Map(this.state.trend().byDay.map((day) => [
      day.date,
      day.completedCards,
    ])),
  }]);

  ngOnInit(): void {
    void this.state.initialize();
    if (this.isOrgAdmin() && this.auth.entitlements()?.tier === "trial" && this.trialDaysLeft() <= 10) {
      void this.api.get<BillingDowngradePreviewResponse>("/billing/downgrade-preview")
        .then((preview) => {
          const normalized = {
            boards: Array.isArray(preview?.boards) ? preview.boards : [],
            members: Array.isArray(preview?.members) ? preview.members : [],
            features: Array.isArray(preview?.features) ? preview.features : [],
          };
          this.downgradePreview.set(normalized);
          if (normalized.boards.length || normalized.members.length || normalized.features.length) {
            this.analytics.track("downgrade_impact_viewed", {
              affected_board_count: normalized.boards.length,
              affected_member_count: normalized.members.length,
              affected_feature_count: normalized.features.length,
              trial_days_remaining: this.trialDaysLeft(),
              upgrade_source: "home",
            });
          }
        })
        .catch(() => undefined);
    }
  }

  async acceptInvitation(id: string): Promise<void> {
    this.acceptingInvitationId.set(id);
    this.invitationError.set(null);
    try {
      const boardId = await this.invitations.accept(id);
      await this.router.navigate(["/b", boardId]);
    } catch (error: unknown) {
      this.invitationError.set(describeAcceptInvitationError(error).message);
    } finally {
      this.acceptingInvitationId.set(null);
    }
  }

  invitationBoardNames(boards: { boardName: string }[]): string {
    return boards.map((board) => board.boardName).join(", ");
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
    void this.router.navigate(["/b", item.boardId, "c", item.cardId], {
      browserUrl: cardPath(item.organisationKey, item.cardKey),
    });
  }

  openBoard(boardId: string): void {
    void this.router.navigate(["/b", boardId]);
  }

  /* ── Up next ────────────────────────────────────────────────────────────────
   *
   * The head of the shell-wide queue, rendered with the same `k-priority-queue` the drawer and the
   * My Cards dock use and mutated through the same service — so a reorder here is instantly the
   * same reorder there, with no second copy to reconcile.
   */

  readonly priorityError = signal<string | null>(null);

  /** Withheld offline rather than served from cache: a stale sequence reads as an instruction. */
  readonly prioritiesOffline = computed(() => !this.myPriorities.online());
  readonly showPriorities = computed(
    () => !this.prioritiesOffline() && this.myPriorities.items().length > 0
  );
  /**
   * Nothing renders for an empty queue — an empty heading is noise, the same rule `groups` follows.
   * The one exception is the discoverability line: someone with assigned work but no queue is told
   * the feature exists, once, in a single muted sentence.
   */
  readonly showPrioritiesHint = computed(
    () => this.myPriorities.items().length === 0 && this.state.counts().assignedCards > 0
  );

  openPriorityCard(event: { cardId: string; boardId: string }): void {
    void this.router.navigate(["/b", event.boardId, "c", event.cardId], {
      browserUrl: this.myPriorities.cardBrowserUrl(event.cardId) ?? undefined,
    });
  }

  onPriorityReordered(event: { priorityId: string; afterId?: string | null; beforeId?: string | null }): void {
    this.priorityError.set(null);
    const { priorityId, ...anchor } = event;
    void this.myPriorities.movePriority(priorityId, anchor).catch(() => {
      this.priorityError.set($localize`:Error on the Up next list:We couldn’t reorder that card. Its previous position has been restored.`);
    });
  }

  onPriorityRemoved(event: { priorityId: string }): void {
    this.priorityError.set(null);
    void this.myPriorities.removePriority(event.priorityId).catch(() => {
      this.priorityError.set($localize`:Error on the Up next list:We couldn’t remove that card from Up next. It has been put back.`);
    });
  }

  onPriorityCompleted(event: { cardId: string; completed: boolean }): void {
    this.priorityError.set(null);
    void this.myPriorities.setCardCompleted(event.cardId, event.completed).catch(() => {
      this.priorityError.set($localize`:Error on the Up next list:We couldn’t update that card. Nothing has changed.`);
    });
  }

  /**
   * Back into first-run onboarding from the blank home page. No plan gate here: the onboarding page
   * enforces its own board headroom, and onboardingGuard admits a no-workspace admin regardless of
   * the "skipped" flag, which only workspaceGuard consults.
   */
  newWorkspace(): void {
    if (this.boardLimitReached()) {
      this.createAttempted.set("workspace");
      void this.upgradePrompt.open({ reason: "board", source: "home", boardCount: this.state.boardCount() });
      return;
    }
    this.createAttempted.set(null);
    void this.router.navigateByUrl("/onboarding?mode=workspace");
  }

  /** Same dialog and same plan gate the sidebar uses, so both entry points behave identically. */
  newStandaloneBoard(): void {
    if (this.boardLimitReached()) {
      this.createAttempted.set("board");
      void this.upgradePrompt.open({ reason: "board", source: "home", boardCount: this.state.boardCount() });
      return;
    }
    this.createAttempted.set(null);
    const ref = this.dialog.open<string>(StandaloneBoardCreateDialogComponent, {
      ariaLabel: $localize`:Dialog label:Create standalone board`,
      width: "min(440px, calc(100vw - 32px))",
      maxWidth: "100vw",
    });
    ref.closed.subscribe((boardId) => {
      if (boardId) void this.router.navigate(["/b", boardId]);
    });
  }
}
