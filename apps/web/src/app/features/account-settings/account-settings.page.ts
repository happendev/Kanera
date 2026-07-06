import type { OnDestroy, OnInit} from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewEncapsulation, computed, effect, inject, signal, untracked } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from "@angular/router";
import type { BillingInfoResponse, NotificationSettingsResponse, NotificationSettingType, PublicClientResponse, SeatChangeResponse } from "@kanera/shared/dto";
import type { ServerToClientEvents } from "@kanera/shared/events";
import type { SmtpConfig, StorageConfig } from "@kanera/shared/schema";
import { filter } from "rxjs";
import { buildInfo } from "../../../build-info.generated";
import { ApiClient, ApiError } from "../../core/api/api.client";
import type { OrgRole } from "../../core/auth/auth.service";
import { AuthService } from "../../core/auth/auth.service";
import { STORAGE_KEYS } from "../../core/browser/browser-contracts";
import { BrowserPushService } from "../../core/notifications/browser-push.service";
import { MentionSoundService } from "../../core/notifications/mention-sound.service";
import { SocketService } from "../../core/realtime/socket.service";
import { ThemeService } from "../../core/theme/theme.service";
import { ConfirmService } from "../../shared/confirm.service";
import { SeatPaymentService } from "../../shared/seat-payment.service";
import { AccountSettingsPlanPage } from "./account-plan/account-plan.page";
import { AccountSettingsNotificationsPage } from "./notifications/notifications.page";
import { AccountSettingsOrgPage } from "./org/org.page";
import { AccountSettingsProfilePage } from "./profile/profile.page";
import { AccountSettingsUsersPage } from "./users/users.page";

type Tab = "profile" | "notifications" | "org" | "users" | "account-plan";

type WorkspaceGrant = { workspaceId: string; workspaceName: string; role: "admin" | "member" };

interface OrgUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
  role: OrgRole;
  createdAt: string;
  // Set when the member was suspended by a plan downgrade; they cannot sign in until the org upgrades.
  suspendedAt: string | null;
  workspaces: WorkspaceGrant[];
}

const ORG_ROLE_RANK: Record<OrgRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

interface OrgGuestSeat {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  lastOnlineAt?: string | Date | null;
  userClientId: string;
  createdAt: string;
  boards: Array<{
    boardId: string;
    boardName: string;
    workspaceId: string;
    workspaceName: string;
    role: "editor" | "observer";
  }>;
}

interface ArchivedWorkspace {
  id: string;
  name: string;
  archivedAt: string;
}

interface OrgInvite {
  id: string;
  email: string | null;
  orgRole: OrgRole;
  expiresAt: string | null;
  createdAt: string;
  createdById: string;
  workspaces: WorkspaceGrant[];
  url?: string;
}

interface InviteWorkspaceSelection {
  workspaceId: string;
  workspaceName: string;
  selected: boolean;
  role: "admin" | "member";
}

type BillingPortalIntent = "home" | "invoices" | "cancel_subscription" | "payment_method";
type BillingSeatErrorBody = { code?: string; message?: string; portalIntent?: BillingPortalIntent };
type SeatNotice = { kind: "info" | "success" | "warning" | "error"; message: string; action?: "refresh_status" | "payment_method" };

type GitHubAppInstallationRow = {
  id: string;
  clientId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  repositories: { owner: string; name: string; fullName: string; private: boolean }[];
  createdAt: string | Date;
  updatedAt: string | Date;
};

type GitHubAppConfig = {
  configured: boolean;
  installUrl: string | null;
  appSlug: string | null;
  source: "env" | "manifest" | null;
  pendingInstallation?: boolean;
};

type GitHubManifestResponse = {
  actionUrl: string;
  manifest: string;
  state: string;
};

type AuthConfigResponse = {
  emailVerificationEnabled: boolean;
};

const NOTIFICATION_ROWS: { key: NotificationSettingType; label: string }[] = [
  { key: "cardAssigned", label: "Card assigned" },
  { key: "cardCommentAdded", label: "Card comment added" },
  { key: "commentMentioned", label: "Tagged in a comment" },
  { key: "cardDueDateChanged", label: "Card due date changed" },
  { key: "cardOverdue", label: "Card overdue" },
];

function formatBuildDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatCents(value: number): string {
  const dollars = value / 100;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    // narrowSymbol renders "$" rather than the locale-dependent "US$" some locales use for USD.
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
  }).format(dollars);
}

@Component({
  selector: "k-account-settings",
  standalone: true,
  imports: [RouterLink, AccountSettingsProfilePage, AccountSettingsNotificationsPage, AccountSettingsUsersPage, AccountSettingsOrgPage, AccountSettingsPlanPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  templateUrl: "./account-settings.page.html",
  styleUrl: "./account-settings.page.scss",
})
export class AccountSettingsPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  private readonly seatPayment = inject(SeatPaymentService);
  readonly browserPush = inject(BrowserPushService);
  readonly mentionSound = inject(MentionSoundService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef);
  private readonly sockets = inject(SocketService);
  readonly theme = inject(ThemeService);
  private detachSocket: (() => void) | null = null;

  private readonly routeTab = signal<string | undefined>(undefined);

  readonly user = this.auth.user;
  readonly isClientAdmin = this.auth.isOrgAdmin;
  readonly isOrgOwner = this.auth.isOrgOwner;
  readonly buildVersion = buildInfo.version;
  readonly buildBuiltAt = formatBuildDate(buildInfo.builtAt);
  readonly storageUsagePercent = computed(() => {
    const usage = this.user()?.storageUsage;
    if (!usage?.limited || !usage.quotaBytes) return 0;
    return Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100));
  });
  readonly storageUsageLabel = computed(() => {
    const usage = this.user()?.storageUsage;
    if (!usage) return "";
    const used = formatBytes(usage.usedBytes);
    return usage.limited && usage.quotaBytes !== null ? `${used} of ${formatBytes(usage.quotaBytes)} used` : `${used} used`;
  });
  readonly storageRemainingLabel = computed(() => {
    const usage = this.user()?.storageUsage;
    if (!usage?.limited || usage.remainingBytes === null) return "Storage is unlimited on this deployment.";
    return `${formatBytes(usage.remainingBytes)} remaining`;
  });
  // A paid org that has exhausted its pool can't self-serve an upgrade (it's already on the top tier),
  // so the account-plan UI points it at support instead of an upgrade CTA.
  readonly storageFull = computed(() => {
    const usage = this.user()?.storageUsage;
    return !!usage?.limited && usage.quotaBytes !== null && usage.usedBytes >= usage.quotaBytes;
  });

  readonly selectedTab = signal<Tab>("profile");
  readonly notificationRows = NOTIFICATION_ROWS;

  // Users tab
  readonly orgUsers = signal<OrgUser[]>([]);
  readonly orgGuestSeats = signal<OrgGuestSeat[]>([]);
  readonly orgGuestSeatRows = computed(() =>
    this.orgGuestSeats().map((guest) => ({
      ...guest,
      workspaces: Array.from(
        new Map(guest.boards.map((board) => [board.workspaceId, board.workspaceName])).entries(),
        ([workspaceId, workspaceName]) => ({ workspaceId, workspaceName }),
      ),
    })),
  );
  readonly orgUserSearch = signal("");
  readonly filteredOrgUsers = computed(() => {
    const q = this.orgUserSearch().trim().toLowerCase();
    const users = q
      ? this.orgUsers().filter(
          (u) => u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
        )
      : this.orgUsers();
    return [...users].sort(
      (a, b) => ORG_ROLE_RANK[a.role] - ORG_ROLE_RANK[b.role]
        || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
    );
  });
  readonly orgInvites = signal<OrgInvite[]>([]);
  readonly orgUsersError = signal<string | null>(null);
  // Workspaces a plan downgrade archived. Hidden everywhere else; shown read-only here so admins can
  // see why they vanished. Restored automatically when the org upgrades, so there is no manual action.
  readonly archivedWorkspaces = signal<ArchivedWorkspace[]>([]);
  // Members suspended by a downgrade are surfaced with a badge and excluded from the active count.
  readonly suspendedMemberCount = computed(() => this.orgUsers().filter((u) => u.suspendedAt).length);
  // Free-tier hosted orgs cap the number of people. Gates the invite form; API still enforces.
  // Counts active members only, matching the server (pending invites and suspended members don't reserve slots).
  readonly memberLimitReached = computed(() => {
    if (!this.isHosted()) return false;
    const max = this.auth.maxOrgMembers();
    return max !== null && this.orgUsers().filter((u) => !u.suspendedAt).length >= max;
  });
  readonly inviteOrgRole = signal<"member" | "admin">("member");
  readonly inviteExpiresInDays = signal<number | null>(7);
  readonly inviteWorkspaces = signal<InviteWorkspaceSelection[]>([]);
  readonly createdInviteUrl = signal<string | null>(null);
  readonly inviteCopied = signal(false);
  readonly inviteBusy = signal(false);
  readonly inviteError = signal<string | null>(null);

  // Profile
  readonly displayName = signal("");
  readonly nameSaving = signal(false);
  readonly nameSavedAt = signal<number | null>(null);
  readonly nameError = signal<string | null>(null);

  readonly email = signal("");
  readonly emailVerificationEnabled = signal(false);
  readonly emailSaving = signal(false);
  readonly emailSavedAt = signal<number | null>(null);
  readonly emailError = signal<string | null>(null);
  // Email changes are verified: "idle" shows the address field; after a code is sent we
  // switch to "code" to collect it. The change only applies once the code is confirmed.
  readonly emailStep = signal<"idle" | "code">("idle");
  readonly emailCode = signal("");

  // Notifications
  readonly notificationSettings = signal<NotificationSettingsResponse | null>(null);
  readonly notificationSettingsLoading = signal(false);
  readonly notificationSettingsSaving = signal(false);
  readonly pushOptInAttempted = signal(false);
  readonly notificationSettingsError = signal<string | null>(null);
  readonly notificationSettingsSuccess = signal<string | null>(null);
  readonly pushToggleDisabled = computed(() => {
    const settings = this.notificationSettings();
    if (!settings) return true;
    if (this.notificationSettingsSaving() || !settings.push.enabled) return true;
    if (settings.pushEnabled) return false;
    return this.browserPush.loading() || this.browserPush.busy() || this.browserPush.unsupportedReason() !== null || this.browserPush.permission() === "denied";
  });
  readonly pushToggleHelp = computed(() => {
    const settings = this.notificationSettings();
    if (!settings) return "";
    if (settings.push.status === "org-disabled") return "Push notifications are turned off for this organisation.";
    if (settings.push.status === "system-disabled") return "Push notifications are not configured for this Kanera deployment yet.";
    if (settings.pushEnabled || this.pushOptInAttempted() || this.pushToggleDisabled()) return this.browserPush.statusMessage();
    return "Turn on push to receive selected notifications in this browser.";
  });
  readonly pushStatusTitle = computed(() => `${this.browserPush.statusBadge()} - ${this.browserPush.permissionLabel()}`);

  readonly currentPassword = signal("");
  readonly newPassword = signal("");
  readonly confirmPassword = signal("");
  readonly showCurrentPassword = signal(false);
  readonly showNewPassword = signal(false);
  readonly showConfirmPassword = signal(false);
  readonly passwordSaving = signal(false);
  readonly passwordError = signal<string | null>(null);
  readonly passwordSuccess = signal<string | null>(null);

  // Org
  readonly client = signal<PublicClientResponse | null>(null);
  readonly requireMfaDraft = signal(false);
  readonly requireMfaSaving = signal(false);
  readonly requireMfaError = signal<string | null>(null);
  readonly billingInfo = signal<BillingInfoResponse | null>(null);
  readonly isHosted = computed(() => (this.client()?.deploymentMode ?? this.user()?.deploymentMode) === "hosted");
  readonly isSelfHosted = computed(() => (this.client()?.deploymentMode ?? this.user()?.deploymentMode) === "self_hosted");
  // Plan/trial state for the hosted-mode Account section. Derived from the org-wide entitlements on
  // /me; the actual purchase + upgrade flow will live in this section later.
  readonly planTier = computed(() => this.auth.entitlements()?.tier ?? null);
  readonly planLabel = computed(() => {
    switch (this.planTier()) {
      case "trial": return "Free trial";
      case "paid": return "Pro";
      case "free": return "Free";
      default: return "—";
    }
  });
  readonly trialEndsAt = computed(() => {
    const iso = this.auth.entitlements()?.trialEndsAt ?? null;
    return iso ? new Date(iso) : null;
  });
  readonly trialDaysLeft = computed(() => {
    const end = this.trialEndsAt();
    if (!end) return 0;
    return Math.max(0, Math.ceil((end.getTime() - Date.now()) / 86_400_000));
  });
  readonly freePlanMaxBoards = computed(() => this.client()?.freePlanLimits?.maxBoards ?? this.auth.entitlements()?.maxBoards ?? 3);
  readonly freePlanMaxOrgMembers = computed(() => this.client()?.freePlanLimits?.maxOrgMembers ?? this.auth.entitlements()?.maxOrgMembers ?? 5);
  readonly freePlanMaxEnabledAutomations = computed(() => this.client()?.freePlanLimits?.maxEnabledAutomations ?? this.auth.entitlements()?.maxEnabledAutomations ?? 1);
  readonly proPricing = signal<{ monthlyCents: number; annualCents: number } | null>(null);
  readonly billingInterval = signal<"monthly" | "annual">("monthly");
  readonly upgradeBusy = signal(false);
  readonly upgradeError = signal<string | null>(null);
  readonly billingPortalBusy = signal<BillingPortalIntent | null>(null);
  readonly cancelError = signal<string | null>(null);
  readonly selectedProPriceLabel = computed(() => {
    const pricing = this.proPricing();
    if (!pricing) return "Contact us";
    const cents = this.billingInterval() === "annual" ? pricing.annualCents : pricing.monthlyCents;
    return `${formatCents(cents)}/user/mo`;
  });
  // Seats currently occupied (members + paid guest seats).
  readonly usedSeats = computed(() => this.billingInfo()?.usedSeats ?? this.billingInfo()?.seatCount ?? 1);
  // Effective allowance from /billing/me. For paid it is purchased capacity; for Free it is the member
  // cap; for Trial it mirrors current usage because trials are unlimited until checkout.
  readonly purchasedSeats = computed(() => this.billingInfo()?.seatLimit ?? 1);
  readonly availableSeats = computed(() => Math.max(0, this.purchasedSeats() - this.usedSeats()));
  // How many seats the admin wants to buy / provision. Initialised from the current pool on load.
  readonly desiredSeats = signal(1);
  readonly seatBusy = signal(false);
  readonly seatError = signal<string | null>(null);
  readonly seatNotice = signal<SeatNotice | null>(null);
  readonly seatPaymentActionRequired = signal(false);
  // Cost projections track the desired (to-be-purchased) capacity, since that is what Stripe bills.
  readonly checkoutTotalLabel = computed(() => {
    const pricing = this.proPricing();
    if (!pricing) return "Contact us";
    const seats = this.desiredSeats();
    if (this.billingInterval() === "annual") {
      return `${formatCents(pricing.annualCents * seats * 12)} billed yearly`;
    }
    return `${formatCents(pricing.monthlyCents * seats)}/mo total`;
  });
  readonly checkoutSeatLabel = computed(() => {
    const seats = this.desiredSeats();
    return `${seats} seat${seats === 1 ? "" : "s"}`;
  });
  readonly checkoutAnnualTotalLabel = computed(() => {
    const pricing = this.proPricing();
    if (!pricing) return "";
    return `${formatCents(pricing.annualCents)}/user/mo equivalent`;
  });
  readonly proSeatPriceLabel = computed(() => {
    const pricing = this.proPricing();
    return pricing ? `${formatCents(pricing.monthlyCents)}/user/mo` : "the Pro seat price";
  });
  readonly monthlyBillingLabel = computed(() => {
    const monthlyCents = this.proPricing()?.monthlyCents;
    return monthlyCents === undefined ? "Monthly billing" : `${formatCents(monthlyCents)}/user/month`;
  });
  readonly annualBillingLabel = computed(() => {
    const annualCents = this.proPricing()?.annualCents;
    return annualCents === undefined ? "" : `${formatCents(annualCents * 12)}/user billed yearly`;
  });
  readonly annualSavingsLabel = computed(() => {
    const pricing = this.proPricing();
    if (!pricing) return "";
    const savingsCents = (pricing.monthlyCents - pricing.annualCents) * 12;
    if (savingsCents <= 0 || pricing.monthlyCents <= 0) return "";
    const percent = Math.round(((pricing.monthlyCents - pricing.annualCents) / pricing.monthlyCents) * 100);
    return `Save ${percent}% (${formatCents(savingsCents)}/user/year)`;
  });
  readonly orgName = signal("");
  readonly orgNameSaving = signal(false);
  readonly orgNameSavedAt = signal<number | null>(null);
  readonly orgError = signal<string | null>(null);
  readonly pushEnabledDraft = signal(false);
  readonly pushSaving = signal(false);
  readonly pushError = signal<string | null>(null);
  readonly pushSuccess = signal<string | null>(null);
  readonly logoUploading = signal(false);
  readonly logoError = signal<string | null>(null);
  readonly githubAppConfig = signal<GitHubAppConfig | null>(null);
  readonly githubInstallation = signal<GitHubAppInstallationRow | null>(null);
  readonly githubError = signal<string | null>(null);
  readonly githubCompleting = signal(false);
  readonly githubAccountLogin = signal("");
  readonly githubManifestStarting = signal(false);

  readonly storageKind = signal<"local" | "s3">("local");
  readonly s3Region = signal("");
  readonly s3Bucket = signal("");
  readonly s3Endpoint = signal("");
  readonly s3AccessKeyId = signal("");
  readonly s3AccessKeyIsSaved = signal(false);
  readonly s3SecretAccessKey = signal("");
  readonly s3PublicUrlPrefix = signal("");
  readonly s3SecretIsSaved = signal(false);
  readonly storageSaving = signal(false);
  readonly storageTesting = signal(false);
  readonly storageError = signal<string | null>(null);
  readonly storageSavedAt = signal<number | null>(null);
  readonly storageTestError = signal<string | null>(null);
  readonly storageTestSuccess = signal<string | null>(null);
  readonly storageBusy = computed(() => this.storageSaving() || this.storageTesting());
  readonly storageFromEnv = computed(() => this.client()?.storageConfigSource === "env");

  readonly smtpHost = signal("");
  readonly smtpPort = signal(587);
  readonly smtpSecurity = signal<"none" | "starttls" | "tls">("starttls");
  readonly smtpUsername = signal("");
  readonly smtpUsernameIsSaved = signal(false);
  readonly smtpPassword = signal("");
  readonly showSmtpPassword = signal(false);
  readonly smtpTestTo = signal("");
  readonly smtpFromEmail = signal("");
  readonly smtpFromName = signal("");
  readonly smtpPasswordIsSaved = signal(false);
  readonly smtpConfigSource = signal<"env" | "client" | null>(null);
  readonly smtpFromEnv = computed(() => this.smtpConfigSource() === "env");
  readonly smtpTestOpen = signal(false);
  readonly smtpSaving = signal(false);
  readonly smtpTesting = signal(false);
  readonly smtpError = signal<string | null>(null);
  readonly smtpSuccess = signal<string | null>(null);
  readonly smtpTestError = signal<string | null>(null);
  readonly smtpTestSuccess = signal<string | null>(null);

  constructor() {
    this.updateRouteTab();
    this.router.events
      ?.pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.updateRouteTab());

    effect(() => {
      if (!this.user()) return;
      const t = this.routeTab();
      if (((t === "org" || t === "users" || t === "account-plan") && !this.isClientAdmin()) || (t === "account-plan" && !this.isHosted())) {
        this.selectedTab.set("profile");
        void this.router.navigate(["profile"], {
          relativeTo: this.route,
          replaceUrl: true,
        });
      } else if (t === "org" || t === "users" || t === "notifications" || t === "account-plan") {
        this.selectedTab.set(t);
      } else {
        this.selectedTab.set("profile");
      }
    });

    effect(() => {
      if (this.user() && this.selectedTab() === "users" && this.isClientAdmin()) {
        void this.loadOrgUsers();
        this.attachOrgSocket();
      }
    });

    effect(() => {
      if (this.user() && this.selectedTab() === "notifications") {
        untracked(() => void this.loadNotificationSettings());
      }
    });

    effect(() => {
      const tab = this.selectedTab();
      if (!this.user()) return;
      if (((tab === "org" || tab === "users" || tab === "account-plan") && !this.isClientAdmin()) || (tab === "account-plan" && !this.isHosted())) {
        this.selectTab("profile", true);
      }
    });
  }

  private updateRouteTab() {
    this.routeTab.set(this.route.firstChild?.snapshot?.url?.[0]?.path);
  }

  ngOnInit() {
    const u = this.user();
    if (u) {
      this.displayName.set(u.displayName);
      this.email.set(u.email);
    }

    if (this.isClientAdmin()) void this.loadClient();
    void this.loadAuthConfig();
    void this.browserPush.initialise();
    void this.handleSeatPaymentReturn();
  }

  // If a redirect-wallet authentication (e.g. Revolut Pay) returns with Stripe status params, settle the
  // seat increase and strip the query params so a refresh can't replay it.
  private async handleSeatPaymentReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("seat_payment") !== "return") return;
    const status = params.get("redirect_status");
    window.history.replaceState({}, "", "/settings/account-plan");
    if (status === "succeeded") {
      await this.settleSeatPayment();
    } else if (status === "pending") {
      this.setSeatPaymentPendingNotice("Payment submitted. Revolut is still confirming it with Stripe. We haven't added seats yet, and we'll add them automatically once the payment is fully confirmed.");
    } else if (status) {
      this.seatNotice.set({ kind: "warning", message: "Payment wasn't completed, so no seats were added." });
    }
  }

  ngOnDestroy() {
    this.detachSocket?.();
  }

  private async loadClient() {
    try {
      const c = await this.api.get<PublicClientResponse>("/clients/me");
      this.applyClient(c);
      if (c.deploymentMode === "hosted") {
        await this.loadBillingInfo();
      }
      const [githubConfig, githubInstallation] = await Promise.all([
        this.api.get<GitHubAppConfig>("/clients/me/github-app/config"),
        this.api.get<GitHubAppInstallationRow | null>("/clients/me/github-app/installation"),
      ]);
      this.githubAppConfig.set(githubConfig);
      this.githubInstallation.set(githubInstallation);
      await this.completePendingGitHubInstall();
    } catch (err) {
      this.orgError.set(extractErrorMessage(err));
    }
  }

  private async loadAuthConfig() {
    try {
      const config = await this.api.get<AuthConfigResponse>("/auth/config");
      this.emailVerificationEnabled.set(config.emailVerificationEnabled);
    } catch {
      this.emailVerificationEnabled.set(false);
    }
  }

  private applyClient(c: PublicClientResponse) {
    this.client.set(c);
    this.proPricing.set(c.proPricing);
    this.orgName.set(c.name);
    if (!this.githubAccountLogin()) {
      this.githubAccountLogin.set(c.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""));
    }
    this.pushEnabledDraft.set(c.pushEnabled);
    this.requireMfaDraft.set(c.requireMfa);
    const sc = c.storageConfig;
    if (sc.kind === "s3") {
      this.storageKind.set("s3");
      this.s3Region.set(sc.region);
      this.s3Bucket.set(sc.bucket);
      this.s3Endpoint.set(sc.endpoint ?? "");
      this.s3AccessKeyId.set(sc.accessKeyId === "***" ? "" : sc.accessKeyId);
      this.s3AccessKeyIsSaved.set(sc.accessKeyId === "***");
      this.s3SecretAccessKey.set("");
      this.s3SecretIsSaved.set(sc.secretAccessKey === "***");
      this.s3PublicUrlPrefix.set(sc.publicUrlPrefix ?? "");
    } else {
      this.storageKind.set("local");
      this.s3AccessKeyIsSaved.set(false);
      this.s3SecretIsSaved.set(false);
    }

    const smtp = c.smtpConfig;
    this.smtpConfigSource.set(c.smtpConfigSource);
    if (smtp) {
      this.smtpHost.set(smtp.host);
      this.smtpPort.set(smtp.port);
      this.smtpSecurity.set(smtp.security);
      this.smtpUsername.set(smtp.username === "***" ? "" : smtp.username ?? "");
      this.smtpUsernameIsSaved.set(smtp.username === "***");
      this.smtpPassword.set("");
      if (!this.smtpTestTo()) this.smtpTestTo.set(this.user()?.email ?? "");
      this.smtpPasswordIsSaved.set(smtp.password === "***");
      this.smtpFromEmail.set(smtp.fromEmail);
      this.smtpFromName.set(smtp.fromName ?? "");
    } else {
      this.smtpHost.set("");
      this.smtpPort.set(587);
      this.smtpSecurity.set("starttls");
      this.smtpUsername.set("");
      this.smtpUsernameIsSaved.set(false);
      this.smtpPassword.set("");
      if (!this.smtpTestTo()) this.smtpTestTo.set(this.user()?.email ?? "");
      this.smtpPasswordIsSaved.set(false);
      this.smtpFromEmail.set("");
      this.smtpFromName.set("");
    }
  }

  private async loadBillingInfo() {
    try {
      const billing = await this.api.get<BillingInfoResponse>("/billing/me");
      this.billingInfo.set(billing);
      this.proPricing.set(billing.proPricing);
      if (billing.billingInterval) this.billingInterval.set(billing.billingInterval);
      const usedSeats = billing.usedSeats ?? billing.seatCount ?? 1;
      // Paid subscriptions edit purchased capacity; Free/Trial checkout starts from actual usage because
      // Free has an effective member cap and Trial is unlimited until checkout.
      this.desiredSeats.set(this.planTier() === "paid" ? Math.max(billing.seatLimit ?? 1, usedSeats) : usedSeats);
    } catch (err) {
      this.orgError.set(extractErrorMessage(err));
    }
  }

  // ─── Profile actions ──────────────────────────────────────────────────────

  setTheme(theme: "light" | "dark") {
    this.theme.setTheme(theme);
  }

  selectTab(tab: Tab, replaceUrl = false) {
    if ((tab === "org" || tab === "users" || tab === "account-plan") && !this.isClientAdmin()) {
      tab = "profile";
    }
    if (tab === "account-plan" && !this.isHosted()) {
      tab = "profile";
    }
    this.selectedTab.set(tab);
    void this.router.navigate([tab], {
      relativeTo: this.route,
      replaceUrl,
    });
  }

  // ─── Notification actions ────────────────────────────────────────────────

  private async loadNotificationSettings() {
    if (this.notificationSettingsLoading()) return;
    this.notificationSettingsLoading.set(true);
    this.notificationSettingsError.set(null);
    try {
      const settings = await this.api.get<NotificationSettingsResponse>("/notifications/settings");
      this.notificationSettings.set(settings);
      await this.browserPush.initialise(true);
      await this.resumePendingPushOptIn();
    } catch (err) {
      this.notificationSettingsError.set(extractErrorMessage(err));
    } finally {
      this.notificationSettingsLoading.set(false);
    }
  }

  async setNotificationMaster(channel: "email" | "push", checked: boolean) {
    const current = this.notificationSettings();
    if (!current || this.notificationSettingsSaving()) return;
    this.notificationSettingsSaving.set(true);
    this.notificationSettingsError.set(null);
    this.notificationSettingsSuccess.set(null);
    try {
      if (channel === "push") {
        this.pushOptInAttempted.set(true);
        if (checked) {
          this.setPendingPushOptIn(true);
          await this.browserPush.subscribe();
          if (!this.browserPush.subscribed()) {
            this.notificationSettings.set(current);
            return;
          }
        } else {
          this.setPendingPushOptIn(false);
          await this.browserPush.unsubscribe();
        }
      }
      const updated = await this.api.patch<NotificationSettingsResponse>("/notifications/settings", {
        [channel === "email" ? "emailEnabled" : "pushEnabled"]: checked,
      });
      this.notificationSettings.set(updated);
      if (channel === "push") this.setPendingPushOptIn(false);
      this.notificationSettingsSuccess.set("Notification settings saved.");
    } catch (err) {
      this.notificationSettings.set(current);
      this.notificationSettingsError.set(extractErrorMessage(err));
    } finally {
      this.notificationSettingsSaving.set(false);
    }
  }

  private async resumePendingPushOptIn(): Promise<void> {
    const settings = this.notificationSettings();
    if (!settings || settings.pushEnabled || !settings.push.enabled || !this.hasPendingPushOptIn()) return;
    if (this.browserPush.loading() || this.browserPush.busy()) return;
    if (this.browserPush.unsupportedReason() !== null || this.browserPush.permission() !== "granted") return;

    this.notificationSettingsSaving.set(true);
    this.notificationSettingsError.set(null);
    this.notificationSettingsSuccess.set(null);
    this.pushOptInAttempted.set(true);
    try {
      await this.browserPush.subscribe();
      if (!this.browserPush.subscribed()) return;
      const updated = await this.api.patch<NotificationSettingsResponse>("/notifications/settings", { pushEnabled: true });
      this.notificationSettings.set(updated);
      this.setPendingPushOptIn(false);
      this.notificationSettingsSuccess.set("Push notifications enabled.");
    } catch (err) {
      this.notificationSettingsError.set(extractErrorMessage(err));
    } finally {
      this.notificationSettingsSaving.set(false);
    }
  }

  private hasPendingPushOptIn(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEYS.PUSH_OPT_IN_PENDING) === "1";
    } catch {
      return false;
    }
  }

  private setPendingPushOptIn(pending: boolean): void {
    try {
      if (pending) localStorage.setItem(STORAGE_KEYS.PUSH_OPT_IN_PENDING, "1");
      else localStorage.removeItem(STORAGE_KEYS.PUSH_OPT_IN_PENDING);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
  }

  async setNotificationType(type: NotificationSettingType, channel: "email" | "push", checked: boolean) {
    const current = this.notificationSettings();
    if (!current || this.notificationSettingsSaving()) return;
    this.notificationSettingsSaving.set(true);
    this.notificationSettingsError.set(null);
    this.notificationSettingsSuccess.set(null);
    try {
      const updated = await this.api.patch<NotificationSettingsResponse>("/notifications/settings", {
        types: { [type]: { [channel]: checked } },
      });
      this.notificationSettings.set(updated);
      this.notificationSettingsSuccess.set("Notification settings saved.");
    } catch (err) {
      this.notificationSettings.set(current);
      this.notificationSettingsError.set(extractErrorMessage(err));
    } finally {
      this.notificationSettingsSaving.set(false);
    }
  }

  setMentionSoundEnabled(checked: boolean): void {
    this.mentionSound.setEnabled(checked);
    this.notificationSettingsSuccess.set("Notification settings saved.");
    this.notificationSettingsError.set(null);
  }

  // ─── Users tab ─────────────────────────────────────────────────────────────

  private async loadOrgUsers() {
    this.orgUsersError.set(null);
    try {
      const [users, invites, workspaces, archived] = await Promise.all([
        this.api.get<OrgUser[]>("/clients/me/users"),
        this.api.get<OrgInvite[]>("/clients/me/invites"),
        this.api.get<{ id: string; name: string }[]>("/workspaces"),
        this.api.get<ArchivedWorkspace[]>("/clients/me/archived-workspaces"),
      ]);
      const guestSeats = this.isHosted() ? await this.api.get<OrgGuestSeat[]>("/clients/me/guest-seats") : [];
      this.orgUsers.set(users);
      this.orgGuestSeats.set(guestSeats);
      this.orgInvites.set(invites);
      this.archivedWorkspaces.set(archived);
      const existing = new Map(this.inviteWorkspaces().map((w) => [w.workspaceId, w]));
      this.inviteWorkspaces.set(
        workspaces.map((w) => existing.get(w.id) ?? { workspaceId: w.id, workspaceName: w.name, selected: false, role: "member" }),
      );
    } catch (err) {
      this.orgUsersError.set(extractErrorMessage(err));
    }
  }

  orgUserPresenceWorkspaceId(orgUser: OrgUser): string | null {
    // Presence is workspace-scoped, so the org-wide users list subscribes through one shared
    // workspace when available while still using the user-level lastOnlineAt for offline tooltips.
    return orgUser.workspaces[0]?.workspaceId ?? null;
  }

  private attachOrgSocket() {
    if (this.detachSocket) return;
    const socket = this.sockets.connect();
    const handlers: Partial<ServerToClientEvents> = {
      "user:profile:updated": ({ userId, displayName, avatarUrl }) => {
        if (userId === this.user()?.id) this.auth.updateUser((user) => ({ ...user, displayName, avatarUrl }));
        this.orgUsers.update((users) => users.map((user) => user.id === userId ? { ...user, displayName, avatarUrl } : user));
        this.orgGuestSeats.update((guests) => guests.map((guest) => guest.userId === userId ? { ...guest, displayName, avatarUrl } : guest));
      },
      "client:user:role-changed": () => void this.loadOrgUsers(),
      "client:user:removed": ({ userId }) =>
        this.orgUsers.update((users) => users.filter((u) => u.id !== userId)),
      "client:invite:created": (invite) =>
        this.orgInvites.update((invites) =>
          invites.some((i) => i.id === invite.id) ? invites : [...invites, { ...invite, expiresAt: invite.expiresAt as string | null, createdAt: invite.createdAt as string, workspaces: invite.workspaces as WorkspaceGrant[] }],
        ),
      "client:invite:revoked": ({ id }) =>
        this.orgInvites.update((invites) => invites.filter((i) => i.id !== id)),
    };
    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event as keyof ServerToClientEvents, handler as never);
    }
    this.detachSocket = () => {
      for (const [event, handler] of Object.entries(handlers)) {
        socket.off(event as keyof ServerToClientEvents, handler as never);
      }
      this.detachSocket = null;
    };
  }

  toggleInviteWorkspace(workspaceId: string) {
    this.inviteWorkspaces.update((rows) =>
      rows.map((r) => (r.workspaceId === workspaceId ? { ...r, selected: !r.selected } : r)),
    );
  }

  setInviteWorkspaceRole(workspaceId: string, role: "admin" | "member") {
    this.inviteWorkspaces.update((rows) =>
      rows.map((r) => (r.workspaceId === workspaceId ? { ...r, role } : r)),
    );
  }

  async changeOrgRole(userId: string, role: OrgRole) {
    this.orgUsersError.set(null);
    try {
      await this.api.patch(`/clients/me/users/${userId}`, { role });
      await this.loadOrgUsers();
    } catch (err) {
      this.orgUsersError.set(extractErrorMessage(err));
    }
  }

  async removeOrgUser(userId: string) {
    this.orgUsersError.set(null);
    const orgUser = this.orgUsers().find((u) => u.id === userId);
    if (!orgUser) return;
    if (orgUser.role === "owner" && !this.isOrgOwner()) return;
    if (!await this.confirm.open({
      title: `Remove ${orgUser.displayName} from the organisation?`,
      message: "They will lose access to every workspace and board in this organisation.",
      confirmLabel: "Remove",
      danger: true,
    })) return;
    try {
      await this.api.delete(`/clients/me/users/${userId}`);
      this.orgUsers.update((users) => users.filter((u) => u.id !== userId));
      if (this.isHosted()) void this.loadBillingInfo();
    } catch (err) {
      this.orgUsersError.set(extractErrorMessage(err));
    }
  }

  async createInvite(e: Event) {
    e.preventDefault();
    this.inviteError.set(null);
    if (!this.inviteWorkspaces().some((w) => w.selected)) {
      this.inviteError.set("Select at least one workspace before creating an invite.");
      return;
    }
    this.inviteBusy.set(true);
    try {
      const body = {
        orgRole: this.inviteOrgRole(),
        expiresInDays: this.inviteExpiresInDays(),
        workspaces: this.inviteWorkspaces()
          .filter((w) => w.selected)
          .map((w) => ({ workspaceId: w.workspaceId, role: w.role })),
      };
      const res = await this.api.post<{ id: string; token: string }>("/clients/me/invites", body);
      const inviteUrl = `${location.origin}/signup?invite=${res.token}`;
      this.createdInviteUrl.set(inviteUrl);
      this.inviteCopied.set(false);
      await navigator.clipboard.writeText(inviteUrl).then(() => this.inviteCopied.set(true)).catch(() => { });
      this.inviteWorkspaces.update((rows) => rows.map((r) => ({ ...r, selected: false })));
      await this.loadOrgUsers();
      this.orgInvites.update((invites) => invites.map((i) => (i.id === res.id ? { ...i, url: inviteUrl } : i)));
    } catch (err) {
      this.inviteError.set(extractErrorMessage(err));
    } finally {
      this.inviteBusy.set(false);
    }
  }

  async copyInviteUrl() {
    const url = this.createdInviteUrl();
    if (!url) return;
    await navigator.clipboard.writeText(url).catch(() => { });
    this.inviteCopied.set(true);
  }

  async copyInviteLink(invite: OrgInvite) {
    if (invite.url) await navigator.clipboard.writeText(invite.url);
  }

  async revokeInvite(id: string) {
    try {
      await this.api.delete(`/invites/${id}`);
      this.orgInvites.update((invites) => invites.filter((i) => i.id !== id));
    } catch (err) {
      this.orgUsersError.set(extractErrorMessage(err));
    }
  }

  formatInviteExpiry(value: string | null) {
    if (!value) return "Never expires";
    return `Expires ${new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }

  formatInviteCreated(value: string) {
    return `Created ${new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }

  capitalize(value: string) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  async saveDisplayName() {
    const next = this.displayName().trim();
    const current = this.user();
    if (!current || !next || next === current.displayName) return;
    this.nameSaving.set(true);
    this.nameError.set(null);
    try {
      await this.api.patch("/auth/me", { displayName: next });
      this.auth.updateUser((u) => ({ ...u, displayName: next }));
      this.nameSavedAt.set(Date.now());
    } catch (err) {
      this.nameError.set(extractErrorMessage(err));
    } finally {
      this.nameSaving.set(false);
    }
  }

  // Step 1: email a verification code to the new address. We never write the new email
  // until the user proves they control it (step 2).
  async requestEmailChange() {
    const next = this.email().trim();
    const current = this.user();
    if (!current || !next || next === current.email) return;
    this.emailSaving.set(true);
    this.emailError.set(null);
    this.emailSavedAt.set(null);
    try {
      if (!this.emailVerificationEnabled()) {
        await this.api.post("/auth/me/email", { email: next });
        this.auth.updateUser((u) => ({ ...u, email: next }));
        this.emailSavedAt.set(Date.now());
        return;
      }
      await this.api.post("/auth/me/email/request-verification", { email: next });
      this.emailCode.set("");
      this.emailStep.set("code");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.emailError.set("That email address is already registered.");
      } else {
        this.emailError.set(extractErrorMessage(err));
      }
    } finally {
      this.emailSaving.set(false);
    }
  }

  // Step 2: confirm the code and apply the change.
  async confirmEmailChange() {
    const next = this.email().trim();
    const code = this.emailCode().trim();
    if (!next || !/^\d{6}$/.test(code)) {
      this.emailError.set("Enter the 6-digit code from your email.");
      return;
    }
    this.emailSaving.set(true);
    this.emailError.set(null);
    try {
      await this.api.post("/auth/me/email", { email: next, code });
      this.auth.updateUser((u) => ({ ...u, email: next }));
      this.emailStep.set("idle");
      this.emailCode.set("");
      this.emailSavedAt.set(Date.now());
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.emailError.set("That email address is already registered.");
      } else {
        this.emailError.set(extractErrorMessage(err));
      }
    } finally {
      this.emailSaving.set(false);
    }
  }

  cancelEmailChange() {
    this.emailStep.set("idle");
    this.emailCode.set("");
    this.emailError.set(null);
    // Reset the field back to the current address so an abandoned change doesn't linger.
    this.email.set(this.user()?.email ?? "");
  }

  async changePassword(e: Event) {
    e.preventDefault();
    this.passwordError.set(null);
    this.passwordSuccess.set(null);
    const current = this.currentPassword();
    const next = this.newPassword();
    const confirm = this.confirmPassword();
    if (!current || !next || !confirm) {
      this.passwordError.set("Current, new, and confirm password are required.");
      return;
    }
    if (next.length < 8) {
      this.passwordError.set("New password must be at least 8 characters.");
      return;
    }
    if (confirm.length < 8) {
      this.passwordError.set("Confirm new password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      this.passwordError.set("New password and confirmation do not match.");
      return;
    }
    this.passwordSaving.set(true);
    try {
      await this.api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      this.passwordSuccess.set("Password changed. You'll be signed out on the next refresh.");
      this.currentPassword.set("");
      this.newPassword.set("");
      this.confirmPassword.set("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.passwordError.set("Your current password is incorrect.");
      } else {
        this.passwordError.set(extractErrorMessage(err));
      }
    } finally {
      this.passwordSaving.set(false);
    }
  }

  // ─── Organisation actions ─────────────────────────────────────────────────

  async startUpgrade() {
    if (!this.isHosted() || this.upgradeBusy()) return;
    this.upgradeBusy.set(true);
    this.upgradeError.set(null);
    this.cancelError.set(null);
    try {
      const checkout = await this.api.post<{ url: string }>("/billing/checkout", {
        interval: this.billingInterval(),
        seatLimit: Math.max(this.desiredSeats(), this.usedSeats()),
      });
      window.location.assign(checkout.url);
    } catch (err) {
      this.upgradeError.set(extractErrorMessage(err));
    } finally {
      this.upgradeBusy.set(false);
    }
  }

  // Seat-picker helpers (templates cannot reference Math). The lower bound is the used-seat count so an
  // admin can never pick fewer seats than are already assigned; the server enforces the same floor.
  incDesiredSeats() {
    this.desiredSeats.update((n) => n + 1);
  }
  decDesiredSeats() {
    this.desiredSeats.update((n) => Math.max(this.usedSeats(), n - 1));
  }
  setDesiredSeats(value: number) {
    const floor = this.usedSeats();
    this.desiredSeats.set(Math.max(floor, Math.floor(value) || floor));
  }
  setDesiredSeatsFromInput(event: Event) {
    const input = event.target as HTMLInputElement | null;
    if (!input) return;
    this.setDesiredSeats(+input.value);
    // If the signal was already at the floor, setting it again will not trigger a DOM update. Normalize
    // the input directly so manually typing below used seats snaps back immediately.
    input.value = String(this.desiredSeats());
  }

  // Buy more / reduce seats on an existing paid subscription. The server invoices an increase
  // immediately on an active subscription; trials are unlimited until checkout.
  async updateSeats(next: number) {
    if (!this.isHosted() || this.seatBusy()) return;
    const target = Math.max(1, Math.floor(next));
    if (target < this.usedSeats()) {
      this.seatError.set(`You have ${this.usedSeats()} seats assigned. Remove members or guests before reducing capacity.`);
      this.seatNotice.set(null);
      this.seatPaymentActionRequired.set(false);
      return;
    }
    this.seatBusy.set(true);
    this.seatError.set(null);
    this.seatNotice.set(null);
    this.seatPaymentActionRequired.set(false);
    try {
      const res = await this.api.post<SeatChangeResponse>("/billing/seats", { seatLimit: target });
      // When the proration charge needs the customer to confirm (3DS/SCA or a redirect wallet), Stripe gives
      // us a PaymentIntent client_secret to confirm in-app. seat_limit is only applied after we settle.
      if (res.paymentConfirmation) {
        await this.confirmSeatPayment(res.paymentConfirmation);
        return;
      }
      this.applySeatBilling(res);
    } catch (err) {
      const body = err instanceof ApiError ? err.body as BillingSeatErrorBody | undefined : undefined;
      // A genuine decline (no usable payment method) still routes the admin to update their payment method.
      this.seatPaymentActionRequired.set(body?.code === "BILLING_PAYMENT_ACTION_REQUIRED" && body?.portalIntent === "payment_method");
      if (this.seatPaymentActionRequired()) {
        this.seatNotice.set({ kind: "error", message: "We couldn't charge your payment method. Update your payment method, then try adding seats again.", action: "payment_method" });
      } else {
        this.seatError.set(extractErrorMessage(err));
      }
    } finally {
      this.seatBusy.set(false);
    }
  }

  // Confirm the seat-increase proration payment in-app via Stripe.js. Cards authenticate in a 3DS modal;
  // redirect wallets (Revolut Pay) may navigate away and complete asynchronously via Stripe webhooks.
  private async confirmSeatPayment(pc: { clientSecret: string; publishableKey: string }) {
    const result = await this.seatPayment.open({ clientSecret: pc.clientSecret, publishableKey: pc.publishableKey });
    if (result.status === "pending") {
      this.setSeatPaymentPendingNotice("Payment submitted. We're waiting for Stripe to finish confirming it. Seats haven't been added yet, but they'll appear automatically as soon as the payment is fully confirmed.");
      return;
    }
    if (result.status === "cancelled") {
      this.seatNotice.set({ kind: "warning", message: "Payment wasn't completed, so no seats were added." });
      return;
    }
    if (result.status === "error") {
      this.seatNotice.set({ kind: "error", message: result.message });
      return;
    }
    await this.settleSeatPayment();
  }

  async refreshSeatPaymentStatus() {
    if (this.seatBusy()) return;
    this.seatBusy.set(true);
    this.seatError.set(null);
    try {
      await this.settleSeatPayment();
    } finally {
      this.seatBusy.set(false);
    }
  }

  // Promote the paid-for capacity into seat_limit once the payment is confirmed (idempotent with the
  // invoice.paid webhook), and reflect it in the UI immediately.
  private async settleSeatPayment() {
    try {
      const billing = await this.api.post<BillingInfoResponse>("/billing/seats/confirm", {});
      this.applySeatBilling(billing);
      this.seatError.set(null);
      this.seatNotice.set({ kind: "success", message: "Payment confirmed. Seats have been added." });
    } catch (err) {
      const body = err instanceof ApiError ? err.body as { code?: string } | undefined : undefined;
      if (body?.code === "BILLING_PAYMENT_INCOMPLETE") {
        this.setSeatPaymentPendingNotice("Payment submitted. We're finalising your invoice with Stripe. Seats haven't been added yet, and we'll add them automatically once the payment is fully confirmed.");
      } else {
        this.seatError.set(extractErrorMessage(err));
      }
    }
  }

  private applySeatBilling(billing: BillingInfoResponse) {
    this.billingInfo.set(billing);
    this.desiredSeats.set(Math.max(billing.seatLimit, billing.usedSeats));
  }

  private setSeatPaymentPendingNotice(message: string) {
    this.seatNotice.set({ kind: "info", message, action: "refresh_status" });
  }

  async manageBilling(intent: BillingPortalIntent = "home") {
    if (!this.isHosted() || this.billingPortalBusy()) return;
    this.billingPortalBusy.set(intent);
    this.cancelError.set(null);
    this.upgradeError.set(null);
    try {
      const portal = await this.api.post<{ url: string }>("/billing/portal", { intent });
      window.location.assign(portal.url);
    } catch (err) {
      this.cancelError.set(extractErrorMessage(err));
    } finally {
      this.billingPortalBusy.set(null);
    }
  }

  async saveOrgName() {
    const next = this.orgName().trim();
    const current = this.client();
    if (!current || !next || next === current.name) return;
    this.orgNameSaving.set(true);
    this.orgError.set(null);
    try {
      const updated = await this.api.patch<PublicClientResponse>("/clients/me", { name: next });
      this.applyClient(updated);
      this.orgNameSavedAt.set(Date.now());
      this.auth.updateUser((u) => ({ ...u, orgName: updated.name }));
    } catch (err) {
      this.orgError.set(extractErrorMessage(err));
    } finally {
      this.orgNameSaving.set(false);
    }
  }

  async savePushEnabled() {
    const current = this.client();
    const next = this.pushEnabledDraft();
    if (!current || current.pushEnabled === next) return;

    this.pushSaving.set(true);
    this.pushError.set(null);
    this.pushSuccess.set(null);
    try {
      const updated = await this.api.patch<PublicClientResponse>("/clients/me", { pushEnabled: next });
      this.applyClient(updated);
      this.pushSuccess.set(
        updated.pushEnabled
          ? "Browser push enabled for this organisation."
          : "Browser push disabled for this organisation.",
      );
    } catch (err) {
      this.pushEnabledDraft.set(current.pushEnabled);
      this.pushError.set(extractErrorMessage(err));
    } finally {
      this.pushSaving.set(false);
    }
  }

  async saveRequireMfa() {
    const current = this.client();
    if (!current || current.requireMfa === this.requireMfaDraft()) return;
    this.requireMfaSaving.set(true); this.requireMfaError.set(null);
    try { this.applyClient(await this.api.patch<PublicClientResponse>("/clients/me", { requireMfa: this.requireMfaDraft() })); }
    catch (err) { this.requireMfaDraft.set(current.requireMfa); this.requireMfaError.set(extractErrorMessage(err)); }
    finally { this.requireMfaSaving.set(false); }
  }

  async uploadLogo(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.logoError.set(null);

    if (file.size > 2 * 1024 * 1024) {
      this.logoError.set("Logo must be 2MB or smaller.");
      input.value = "";
      return;
    }

    const form = new FormData();
    form.append("file", file, file.name);

    this.logoUploading.set(true);
    try {
      const updated = await this.api.request<PublicClientResponse>("/clients/me/logo", {
        method: "POST",
        body: form,
      });
      this.applyClient(updated);
      this.auth.updateUser((u) => ({ ...u, logoUrl: updated.logoUrl }));
    } catch (err) {
      this.logoError.set(extractErrorMessage(err));
    } finally {
      this.logoUploading.set(false);
      input.value = "";
    }
  }

  async deleteLogo() {
    this.logoError.set(null);
    this.logoUploading.set(true);
    try {
      const updated = await this.api.delete<PublicClientResponse>("/clients/me/logo");
      this.applyClient(updated);
      this.auth.updateUser((u) => ({ ...u, logoUrl: updated.logoUrl }));
    } catch (err) {
      this.logoError.set(extractErrorMessage(err));
    } finally {
      this.logoUploading.set(false);
    }
  }

  githubInstallHref(): string | null {
    return this.githubInstallHrefFromConfig(this.githubAppConfig());
  }

  githubRepositoryAccessLabel(installation: GitHubAppInstallationRow): string {
    if (installation.repositorySelection === "all") return "All repositories";
    const count = installation.repositories.length;
    if (count === 0) return "No private repositories selected";
    return `${count} selected repositor${count === 1 ? "y" : "ies"}`;
  }

  private githubInstallHrefFromConfig(config: GitHubAppConfig | null): string | null {
    const url = config?.installUrl;
    if (!url) return null;
    const next = new URL(url);
    next.searchParams.set("state", "org");
    return next.toString();
  }

  private continueToGitHubInstall(config: GitHubAppConfig) {
    const href = this.githubInstallHrefFromConfig(config);
    if (href) window.location.assign(href);
  }

  async completePendingGitHubInstall() {
    const code = this.route.snapshot.queryParamMap.get("code");
    const installationId = this.route.snapshot.queryParamMap.get("installation_id");
    if ((!code && !installationId) || this.githubCompleting()) return;
    this.githubCompleting.set(true);
    this.githubError.set(null);
    try {
      if (code) {
        const config = await this.api.post<GitHubAppConfig>("/clients/me/github-app/manifest/complete", {
          code,
          state: this.route.snapshot.queryParamMap.get("state") ?? undefined,
        });
        this.githubAppConfig.set(config);
        if (!installationId && config.installUrl) {
          this.continueToGitHubInstall(config);
          return;
        }
      }
      if (installationId) {
        const installation = await this.api.post<GitHubAppInstallationRow>("/clients/me/github-app/installation", {
          installationId,
        });
        this.githubInstallation.set(installation);
        const config = await this.api.get<GitHubAppConfig>("/clients/me/github-app/config");
        this.githubAppConfig.set(config);
      }
      await this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { code: null, installation_id: null, setup_action: null, state: null, tab: "org" },
        queryParamsHandling: "merge",
        replaceUrl: true,
      });
    } catch (error) {
      this.githubError.set(extractErrorMessage(error));
    } finally {
      this.githubCompleting.set(false);
    }
  }

  async createGitHubAppFromManifest(event: Event) {
    event.preventDefault();
    if (!this.isSelfHosted()) return;
    const accountLogin = this.githubAccountLogin().trim();
    if (!accountLogin) return;
    const popup = window.open("", "_blank");
    if (!popup) {
      this.githubError.set("Your browser blocked the GitHub setup window. Allow pop-ups for Kanera and try again.");
      return;
    }
    popup.document.title = "Opening GitHub";
    popup.document.body.textContent = "Opening GitHub...";

    this.githubManifestStarting.set(true);
    this.githubError.set(null);
    try {
      const response = await this.api.post<GitHubManifestResponse>("/clients/me/github-app/manifest", { accountLogin });
      this.submitGitHubManifest(response, popup);
    } catch (error) {
      popup.close();
      this.githubError.set(extractErrorMessage(error));
    } finally {
      this.githubManifestStarting.set(false);
    }
  }

  private submitGitHubManifest(manifestForm: GitHubManifestResponse, targetWindow: Window) {
    const doc = targetWindow.document;
    doc.body.textContent = "Opening GitHub...";

    const form = doc.createElement("form");
    form.method = "POST";
    form.action = manifestForm.actionUrl;
    form.target = "_self";
    form.style.display = "none";

    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = manifestForm.manifest;
    form.appendChild(input);

    doc.body.appendChild(form);
    HTMLFormElement.prototype.submit.call(form);
  }

  async disconnectGitHub() {
    const installation = this.githubInstallation();
    if (!installation) return;
    if (!await this.confirm.open({ title: `Disconnect GitHub from ${installation.accountLogin}?`, message: "Kanera will keep the GitHub App configured so you can reinstall it without setting it up again." })) return;
    this.githubError.set(null);
    try {
      await this.api.delete("/clients/me/github-app/installation");
      this.githubInstallation.set(null);
      const config = await this.api.get<GitHubAppConfig>("/clients/me/github-app/config");
      this.githubAppConfig.set(config);
    } catch (error) {
      this.githubError.set(extractErrorMessage(error));
    }
  }

  // Only available for self-hosted deployments that bootstrapped the app via the
  // manifest flow; env-configured deployments manage credentials through the environment.
  canForgetGitHubApp(): boolean {
    return this.isSelfHosted() && this.githubAppConfig()?.source === "manifest";
  }

  async forgetGitHubApp() {
    if (!this.isSelfHosted()) return;
    if (!await this.confirm.open({ title: "Forget GitHub App setup?", message: "This removes the stored GitHub App credentials from Kanera. You will need to set up a new GitHub App to reconnect." })) return;
    this.githubError.set(null);
    try {
      await this.api.delete("/clients/me/github-app");
      this.githubInstallation.set(null);
      this.githubAppConfig.set({ configured: false, installUrl: null, appSlug: null, source: null });
    } catch (error) {
      this.githubError.set(extractErrorMessage(error));
    }
  }

  async saveStorage() {
    if (!this.isSelfHosted()) return;
    const storageConfig = this.buildStorageConfig("settings");
    if (!storageConfig) return;

    this.storageError.set(null);
    this.storageSaving.set(true);
    try {
      const updated = await this.api.patch<PublicClientResponse>("/clients/me", { storageConfig });
      this.applyClient(updated);
      this.storageSavedAt.set(Date.now());
    } catch (err) {
      this.storageError.set(extractErrorMessage(err));
    } finally {
      this.storageSaving.set(false);
    }
  }

  async testStorage() {
    if (!this.isSelfHosted()) return;
    const storageConfig = this.storageFromEnv() ? null : this.buildStorageConfig("test");
    if (!this.storageFromEnv() && (!storageConfig || storageConfig.kind !== "s3")) return;

    this.storageTestError.set(null);
    this.storageTestSuccess.set(null);
    this.storageTesting.set(true);
    try {
      await this.api.post("/clients/me/storage/test", storageConfig ? { storageConfig } : {});
      this.storageTestSuccess.set("Uploaded and deleted a 1KB test file.");
    } catch (err) {
      this.storageTestError.set(extractErrorMessage(err));
    } finally {
      this.storageTesting.set(false);
    }
  }

  async saveSmtp() {
    if (!this.isSelfHosted()) return;
    const smtpConfig = this.buildSmtpConfig();
    if (!smtpConfig) return;
    this.smtpError.set(null);
    this.smtpSuccess.set(null);
    this.smtpSaving.set(true);
    try {
      const updated = await this.api.patch<PublicClientResponse>("/clients/me", { smtpConfig });
      this.applyClient(updated);
      this.smtpSuccess.set("SMTP settings saved.");
    } catch (err) {
      this.smtpError.set(extractErrorMessage(err));
    } finally {
      this.smtpSaving.set(false);
    }
  }

  async resetSmtpToEnv() {
    if (!this.isSelfHosted()) return;
    this.smtpError.set(null);
    this.smtpSuccess.set(null);
    this.smtpSaving.set(true);
    try {
      const updated = await this.api.patch<PublicClientResponse>("/clients/me", { smtpConfig: null });
      this.applyClient(updated);
      this.smtpSuccess.set(updated.smtpConfigSource === "env" ? "Using Docker environment SMTP settings." : "SMTP settings cleared.");
    } catch (err) {
      this.smtpError.set(extractErrorMessage(err));
    } finally {
      this.smtpSaving.set(false);
    }
  }

  async testSmtp() {
    if (!this.isSelfHosted()) return;
    const smtpConfig = this.smtpFromEnv() ? null : this.buildSmtpConfig("test");
    if (!this.smtpFromEnv() && !smtpConfig) return;
    const to = this.smtpTestTo().trim();
    if (!to) {
      this.smtpTestError.set("Test recipient is required.");
      return;
    }
    this.smtpTestError.set(null);
    this.smtpTestSuccess.set(null);
    this.smtpTesting.set(true);
    try {
      await this.api.post("/clients/me/smtp/test", smtpConfig ? { smtpConfig, to } : { to });
      this.smtpTestSuccess.set(`Sent to ${to}.`);
    } catch (err) {
      this.smtpTestError.set(extractErrorMessage(err));
    } finally {
      this.smtpTesting.set(false);
    }
  }

  toggleSmtpTestPopover() {
    if (this.smtpTesting()) return;
    this.smtpTestOpen.update((open) => !open);
    if (!this.smtpTestTo()) this.smtpTestTo.set(this.user()?.email ?? "");
    this.smtpTestError.set(null);
    this.smtpTestSuccess.set(null);
  }

  @HostListener("document:click", ["$event"])
  onDocumentClick(event: MouseEvent) {
    if (!this.smtpTestOpen()) return;
    const target = event.target as Node | null;
    const hostElement = this.host.nativeElement as HTMLElement;
    const popover = hostElement.querySelector(".smtp-test-wrap");
    if (popover && target && !popover.contains(target)) {
      this.smtpTestOpen.set(false);
    }
  }

  private buildSmtpConfig(errorTarget: "settings" | "test" = "settings"): SmtpConfig | null {
    const host = this.smtpHost().trim();
    const port = Number(this.smtpPort());
    const username = this.smtpUsername().trim();
    const password = this.smtpPassword();
    const fromEmail = this.smtpFromEmail().trim();
    const fromName = this.smtpFromName().trim();
    if (!host || !port || !fromEmail) {
      this.setSmtpError(errorTarget, "Host, port, and from email are required.");
      return null;
    }
    if ((username || this.smtpUsernameIsSaved()) && !password && !this.smtpPasswordIsSaved()) {
      this.setSmtpError(errorTarget, "SMTP password is required when a username is set.");
      return null;
    }
    return {
      host,
      port,
      security: this.smtpSecurity(),
      ...(username || this.smtpUsernameIsSaved() ? { username: username || "***" } : {}),
      ...(password || this.smtpPasswordIsSaved() ? { password: password || "***" } : {}),
      fromEmail,
      ...(fromName ? { fromName } : {}),
    };
  }

  private buildStorageConfig(errorTarget: "settings" | "test" = "settings"): StorageConfig | null {
    if (this.storageKind() === "local") {
      return { kind: "local" };
    }

    const region = this.s3Region().trim();
    const bucket = this.s3Bucket().trim();
    const accessKeyId = this.s3AccessKeyId().trim();
    const typedSecret = this.s3SecretAccessKey();
    const endpoint = this.s3Endpoint().trim();
    const publicUrlPrefix = this.s3PublicUrlPrefix().trim();

    if (!region || !bucket || (!accessKeyId && !this.s3AccessKeyIsSaved())) {
      this.setStorageError(errorTarget, "Region, bucket, and access key are required.");
      return null;
    }

    if (!typedSecret && !this.s3SecretIsSaved()) {
      this.setStorageError(errorTarget, "Secret access key is required.");
      return null;
    }

    return {
      kind: "s3",
      region,
      bucket,
      accessKeyId: accessKeyId || "***",
      secretAccessKey: typedSecret || "***",
      ...(endpoint ? { endpoint } : {}),
      ...(publicUrlPrefix ? { publicUrlPrefix } : {}),
    };
  }

  private setSmtpError(target: "settings" | "test", message: string) {
    if (target === "test") {
      this.smtpTestError.set(message);
    } else {
      this.smtpError.set(message);
    }
  }

  private setStorageError(target: "settings" | "test", message: string) {
    if (target === "test") {
      this.storageTestError.set(message);
    } else {
      this.storageError.set(message);
    }
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string } | undefined;
    return body?.message ?? `Request failed (${err.status})`;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
