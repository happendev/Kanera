import type { AfterViewInit, ElementRef, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, Injector, afterNextRender, computed, inject, input, signal, viewChild } from "@angular/core";
import { NavigationStart, Router, RouterLink } from "@angular/router";
import { cardPath } from "@kanera/shared/card-links";
// Type-only: the dto barrel pulls in zod, which the web bundle deliberately does not ship.
import type { UserProfileRecentCard, UserProfileResponse, UserProfileRole } from "@kanera/shared/dto";
import { AuthService } from "../../core/auth/auth.service";
import { PresenceService } from "../../core/realtime/presence.service";
import { ANCHORED_HOST_STYLES, anchoredSheetStyles } from "../anchored-panel";
import type { AnchorRect } from "../anchored-panel";
import { AnchoredPanelDirective } from "../anchored-panel.directive";
import { AvatarComponent, formatLastOnline } from "../avatar.component";
import { CardKeyDisplayService } from "../card-key-display.service";
import { copyToClipboard } from "../clipboard";
import { formatRelativeTime, formatTime, timeZoneOffsetMinutes } from "../date-format";
import { viewerTimeZone } from "../day-key.util";
import { ToastService } from "../toast.service";
import { TooltipDirective } from "../tooltip.directive";
import { buildProfileActivityGrid } from "./profile-activity-grid";
import { UserProfileCardService, type UserProfileAction, type UserProfileRequest } from "./user-profile-card.service";

/**
 * Skeleton width only. Once loaded the grid takes its week count from the response, so the server's
 * USER_PROFILE_ACTIVITY_WEEKS stays the single source of truth for the window.
 */
const SKELETON_WEEKS = 18;

const ROLE_LABELS: Record<UserProfileRole, string> = {
  owner: "Owner",
  admin: "Admin",
  workspaceAdmin: "Workspace admin",
  member: "Member",
  guest: "Guest",
};

const ROLE_HINTS: Record<UserProfileRole, string> = {
  owner: "Owns this organisation",
  admin: "Organisation admin: manages every workspace and board",
  workspaceAdmin: "Manages this workspace and its boards",
  member: "Organisation member",
  guest: "Guest from outside this organisation, with access to specific boards only",
};

/** "6h behind you", "2h 30m ahead of you"; null when the clocks agree or a zone is unknown. */
function zoneDifferenceLabel(theirZone: string, viewerZone: string, at: Date): string | null {
  const theirs = timeZoneOffsetMinutes(theirZone, at);
  const mine = timeZoneOffsetMinutes(viewerZone, at);
  if (theirs === null || mine === null || theirs === mine) return null;
  const delta = Math.abs(theirs - mine);
  const hours = Math.floor(delta / 60);
  const minutes = delta % 60;
  const amount = [hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ");
  return theirs > mine ? `${amount} ahead of you` : `${amount} behind you`;
}

/**
 * The profile card opened by clicking an avatar.
 *
 * Exactly one instance exists at a time, mounted by the shell from `UserProfileCardService`. The
 * header paints from what the clicked avatar already knew (name, picture, last online) so the card
 * opens instantly; stats, activity, recent cards and shared boards fill in from
 * `GET /users/:id/profile`, which scopes all of them to boards the viewer can see.
 */
@Component({
  selector: "k-user-profile-popover",
  standalone: true,
  imports: [AvatarComponent, RouterLink, TooltipDirective],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./user-profile-popover.component.html",
  // Phones get the shared bottom sheet: a profile opened from a tile near the screen edge would
  // otherwise squeeze the activity grid into a sliver beside it.
  styles: [ANCHORED_HOST_STYLES, anchoredSheetStyles("up-panel")],
  styleUrl: "./user-profile-popover.component.scss",
})
export class UserProfilePopoverComponent implements OnInit, AfterViewInit {
  private readonly panel = inject(AnchoredPanelDirective);
  private readonly service = inject(UserProfileCardService);
  private readonly presence = inject(PresenceService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly cardKeys = inject(CardKeyDisplayService);
  private readonly injector = inject(Injector);
  private readonly panelEl = viewChild<ElementRef<HTMLElement>>("panelEl");

  readonly request = input.required<UserProfileRequest>();

  readonly profile = signal<UserProfileResponse | null>(null);
  readonly loading = signal(true);
  readonly failed = signal(false);
  readonly runningAction = signal<string | null>(null);
  /** Re-renders relative stamps ("Last seen 3 minutes ago", local time) while the card is open. */
  private readonly now = signal(Date.now());
  /**
   * Where the avatar last was. A realtime update can re-render the tile that owned the avatar while
   * the card is open; a detached element measures as a zero box, which would fling the card to the
   * viewport corner, so the card stays where it was instead.
   */
  private lastAnchorRect: AnchorRect | null = null;

  readonly skeletonWeeks = Array.from({ length: SKELETON_WEEKS }, (_, index) => index);
  readonly weekdayLabels = ["Mon", "", "Wed", "", "Fri", "", ""];
  readonly legendLevels = [0, 1, 2, 3, 4] as const;
  readonly showCardKeys = this.cardKeys.showCardKeys;

  constructor() {
    this.panel.configure({
      anchor: () => {
        const anchor = this.request().anchor;
        if (!anchor.isConnected) return this.lastAnchorRect ?? anchor;
        this.lastAnchorRect = anchor.getBoundingClientRect();
        return anchor;
      },
      // margin 8 matches the phone sheet's side insets, so its inline max-width (viewport minus two
      // margins) never leaves a wider gutter on the right than on the left.
      placement: () => {
        // Sized to the card's full content rather than a fixed cap, so it only scrolls when the
        // viewport itself is too short. Requiring the whole height makes placement flip above the
        // avatar when that side has room, and preserveMinHeight lets it slide over the avatar when
        // neither side does but the viewport still fits it.
        const natural = this.naturalHeight();
        const base = { width: 340, gap: 8, margin: 8, maxHeight: natural, minHeight: natural, preserveMinHeight: true };
        // Neither above nor below fits the whole card: open beside the avatar (vertically centred,
        // clamped to the viewport) rather than sliding over the avatar that opened it.
        const rect = this.lastAnchorRect;
        if (rect) {
          const below = window.innerHeight - rect.bottom - 16;
          const above = rect.top - 16;
          if (natural > below && natural > above) return { ...base, side: "right" as const, align: "center" as const };
        }
        return { ...base, side: "bottom" as const, align: "center" as const };
      },
      onDismiss: (reason) => this.close(reason === "escape"),
    });
    const timer = window.setInterval(() => this.now.set(Date.now()), 30_000);
    // Any navigation (a link in the card, the back button, a card opening) leaves the avatar that
    // anchored the card behind, so the card goes with it. Subscribed here rather than in the service
    // so every k-avatar's dependency on the service stays a plain signal read.
    const navigation = inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationStart) this.service.close();
    });
    inject(DestroyRef).onDestroy(() => {
      window.clearInterval(timer);
      navigation.unsubscribe();
    });
  }

  /** Full content height including the border; scrollHeight ignores the panel's own max-height. */
  private naturalHeight(): number {
    const panel = this.panelEl()?.nativeElement;
    if (!panel) return 640;
    const border = panel.offsetHeight - panel.clientHeight;
    return Math.ceil(panel.scrollHeight + border);
  }

  readonly displayName = computed(() => this.profile()?.user.displayName ?? this.request().displayName);
  readonly avatarUrl = computed(() => this.profile()?.user.avatarUrl ?? this.request().avatarUrl);
  readonly isSelf = computed(() => this.profile()?.isSelf ?? this.request().userId === this.auth.user()?.id);
  readonly roleLabel = computed(() => {
    const role = this.profile()?.role;
    return role ? ROLE_LABELS[role] : null;
  });
  readonly roleHint = computed(() => {
    const role = this.profile()?.role;
    return role ? ROLE_HINTS[role] : "";
  });

  /**
   * Presence is per workspace room. The clicked surface's workspace is the natural one; surfaces
   * without one (the team lanes, org settings) fall back to a workspace both people share, so the
   * card does not claim "Last seen 3 days ago" for someone who is online right now.
   */
  readonly presenceWorkspaceId = computed(() =>
    this.request().workspaceId ?? this.profile()?.sharedBoards.boards[0]?.workspaceId ?? null
  );
  readonly online = computed(() =>
    this.isSelf() || this.presence.isOnline(this.presenceWorkspaceId(), this.request().userId)
  );
  readonly presenceLabel = computed(() => {
    if (this.online()) return "Online";
    const lastSeen = this.presence.lastOnlineAt(this.presenceWorkspaceId(), this.request().userId)
      ?? this.profile()?.user.lastOnlineAt
      ?? this.request().lastOnlineAt;
    const relative = formatLastOnline(lastSeen, this.now());
    return relative ? `Last seen ${relative}` : "Offline";
  });

  readonly localTime = computed(() => {
    const zone = this.profile()?.user.timezone;
    if (!zone) return null;
    const at = new Date(this.now());
    const time = formatTime(at, { timeZone: zone });
    if (!time) return null;
    return {
      time,
      zone: zone.replace(/_/g, " "),
      difference: this.isSelf() ? null : zoneDifferenceLabel(zone, viewerTimeZone(), at),
    };
  });

  readonly weeks = computed(() => Math.max(1, Math.floor((this.profile()?.activity.days ?? SKELETON_WEEKS * 7) / 7)));

  readonly grid = computed(() => {
    const profile = this.profile();
    if (!profile) return null;
    const counts = new Map(profile.activity.byDay.map((day) => [day.date, day.count]));
    return buildProfileActivityGrid(counts, profile.today, this.weeks());
  });

  readonly recentCards = computed(() => this.profile()?.recentCards ?? []);
  readonly boards = computed(() => this.profile()?.sharedBoards.boards ?? []);
  readonly hiddenBoardCount = computed(() => {
    const shared = this.profile()?.sharedBoards;
    return shared ? Math.max(0, shared.total - shared.boards.length) : 0;
  });
  readonly boardsHeading = computed(() => this.isSelf() ? "Your boards" : "Boards you share");

  readonly cardsLink = computed(() => this.isSelf()
    ? { path: "/my-cards", query: null }
    : { path: "/team-cards", query: { person: this.request().userId } });
  readonly actions = computed<readonly UserProfileAction[]>(() => this.request().actions ?? []);

  ngOnInit(): void {
    void this.load();
  }

  ngAfterViewInit(): void {
    // Focus moves into the card so Escape and screen readers land on it. Browsers only draw a focus
    // ring for programmatic focus after keyboard use, so a mouse click opens without one.
    this.panelEl()?.nativeElement.focus({ preventScroll: true });
  }

  async load(force = false): Promise<void> {
    const request = this.request();
    this.loading.set(true);
    this.failed.set(false);
    try {
      const profile = await this.service.load(request.userId, request.workspaceId, { force });
      // The request is fixed for this instance's lifetime (the shell rebuilds the card per open), but
      // a slow response could still land after the card closed; that is harmless, not a state leak.
      this.profile.set(profile);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
      // Placement measured the skeleton; the real content is taller. Wait for the render that adds it,
      // since sizing reads the content height (a microtask ran before zoneless change detection).
      afterNextRender(() => this.panel.reposition(), { injector: this.injector });
    }
  }

  close(restoreFocus = false): void {
    const anchor = this.request().anchor;
    this.service.close();
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }

  async copyEmail(email: string): Promise<void> {
    try {
      await copyToClipboard(email);
      this.toast.success("Email copied", "copy");
    } catch {
      this.toast.error("Couldn't copy the email address.");
    }
  }

  async runAction(action: UserProfileAction): Promise<void> {
    if (this.runningAction()) return;
    this.runningAction.set(action.id);
    try {
      await action.run();
      this.close();
    } finally {
      this.runningAction.set(null);
    }
  }

  cardHref(card: UserProfileRecentCard): string | null {
    try {
      return cardPath(card.organisationKey, card.cardKey);
    } catch {
      return null;
    }
  }

  relative(value: string): string {
    return formatRelativeTime(value, { now: new Date(this.now()) });
  }

  boardIconColor(token: string | null): string | null {
    return token ? `var(--color-${token})` : null;
  }
}
