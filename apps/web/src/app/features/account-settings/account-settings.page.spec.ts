import { computed, provideZonelessChangeDetection, signal, type WritableSignal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import type { Entitlements, NotificationSettingsResponse, NotificationWorkspaceRule } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import type { AuthUser } from "../../core/auth/auth.service";
import { AuthService } from "../../core/auth/auth.service";
import { CookieConsentService } from "../../core/consent/cookie-consent.service";
import { BrowserPushService } from "../../core/notifications/browser-push.service";
import { OfflineCacheService } from "../../core/offline/offline-cache.service";
import { SocketService } from "../../core/realtime/socket.service";
import type { AppSocket } from "../../core/realtime/socket.service";
import { ThemeService } from "../../core/theme/theme.service";
import { ConfirmService } from "../../shared/confirm.service";
import { SeatPaymentService } from "../../shared/seat-payment.service";
import { AccountSettingsPage } from "./account-settings.page";

class SocketStub {
  readonly handlers = new Map<string, (...args: unknown[]) => void>();
  readonly on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this.handlers.set(event, handler);
    return this;
  });
  readonly off = vi.fn((event: string) => {
    this.handlers.delete(event);
    return this;
  });

  emitServer(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload);
  }

  asSocket(): AppSocket {
    return this as unknown as AppSocket;
  }
}

const enabledWorkspaceRuleTypes = (): NotificationWorkspaceRule["types"] => ({
  cardAssigned: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
  cardCommentAdded: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
  commentMentioned: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
  cardDueDateChanged: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
  cardOverdue: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
});

describe("AccountSettingsPage", () => {
  let fixture: ComponentFixture<AccountSettingsPage>;
  let entitlements: WritableSignal<Entitlements>;
  let maxOrgMembers: WritableSignal<number | null>;
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let confirmOpen: ReturnType<typeof vi.fn>;
  let seatPaymentOpen: ReturnType<typeof vi.fn>;
  let authRefresh: ReturnType<typeof vi.fn>;
  let authSetSession: ReturnType<typeof vi.fn>;
  let socketDisconnect: ReturnType<typeof vi.fn>;
  let socket: SocketStub;
  let user: WritableSignal<AuthUser | null>;
  let isOrgAdmin: WritableSignal<boolean>;
  let routerNavigate: ReturnType<typeof vi.fn>;
  let offlineCacheClear: ReturnType<typeof vi.fn>;
  let activeSettingsRoute: string;
  let currentClient: unknown;
  let billingSeatCount: number;
  let billingSeatLimit: number;
  let orgUsersResponse: unknown[];
  let orgGuestSeatsResponse: unknown[];
  let archivedWorkspacesResponse: unknown[];
  let emailVerificationEnabled: boolean;
  let githubConfigResponse: unknown;
  let githubInstallationResponse: unknown;
  let notificationSettingsResponse: NotificationSettingsResponse;
  let notificationBoardsResponse: Array<{
    id: string;
    name: string;
    workspaceId: string;
    workspaceName: string;
    workspaceKind: "standard" | "board";
    clientId: string;
    clientName: string;
  }>;

  const hostedClient = {
    id: "client-1",
    name: "Acme",
    logoUrl: null,
    deploymentMode: "hosted" as const,
    pushEnabled: false,
    storageConfig: { kind: "local" as const },
    storageConfigSource: "env" as const,
    smtpConfig: null,
    smtpConfigSource: null,
    // annualCents is the per-seat yearly total, not a monthly equivalent.
    proPricing: { monthlyCents: 500, annualCents: 4900 },
    freePlanLimits: { maxBoards: 3, maxOrgMembers: 4, maxEnabledAutomations: 1 },
  };
  const selfHostedClient = {
    ...hostedClient,
    deploymentMode: "self_hosted" as const,
    proPricing: null,
    freePlanLimits: null,
  };

  beforeEach(async () => {
    user = signal<AuthUser | null>({
      id: "user-1",
      clientId: "client-1",
      email: "owner@example.com",
      displayName: "Owner",
      avatarUrl: null,
      orgName: "Acme",
      logoUrl: null,
      deploymentMode: "hosted",
      hasWorkspace: true,
      role: "owner",
      timezone: "UTC",
      storageUsage: {
        usedBytes: 512 * 1024 * 1024,
        quotaBytes: 1024 * 1024 * 1024,
        remainingBytes: 512 * 1024 * 1024,
        limited: true,
        maxFileBytes: 250 * 1024 * 1024,
      },
    });
    entitlements = signal<Entitlements>({
      tier: "trial",
      trialEndsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      limited: false,
      maxBoards: null,
      maxOrgMembers: null,
      maxEnabledAutomations: null,
      guestsAllowed: true,
      apiAllowed: true,
      webhooksAllowed: true,
    });
    maxOrgMembers = signal<number | null>(null);
    isOrgAdmin = signal(true);
    routerNavigate = vi.fn();
    offlineCacheClear = vi.fn(async () => undefined);
    currentClient = hostedClient;
    billingSeatCount = 1;
    billingSeatLimit = billingSeatCount;
    orgUsersResponse = [];
    orgGuestSeatsResponse = [];
    archivedWorkspacesResponse = [];
    emailVerificationEnabled = false;
    githubConfigResponse = { configured: false, installUrl: null, appSlug: null, source: null };
    githubInstallationResponse = null;
    notificationSettingsResponse = {
      emailEnabled: true,
      pushEnabled: false,
      push: { status: "system-disabled", registrationEnabled: false, enabled: false, publicKey: null },
      personalChannels: {
        destinationPolicy: "public-https",
        ntfy: { enabled: false, configured: false, serverUrl: null, topic: null, tokenConfigured: false },
        gotify: { enabled: false, configured: false, serverUrl: null, tokenConfigured: false },
        webhook: { enabled: false, configured: false, url: null, secretConfigured: false },
      },
      types: {
        cardAssigned: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
        cardCommentAdded: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
        commentMentioned: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
        cardDueDateChanged: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
        cardOverdue: { email: true, push: true, ntfy: true, gotify: true, webhook: true },
      },
      workspaceRules: [],
    };
    notificationBoardsResponse = [{
      id: "board-1",
      name: "Roadmap",
      workspaceId: "workspace-1",
      workspaceName: "Workspace",
      workspaceKind: "standard",
      clientId: "client-1",
      clientName: "Acme",
    }];
    api = {
      get: vi.fn(async (path: string) => {
        if (path === "/auth/config") return { emailVerificationEnabled };
        if (path === "/clients/me") return currentClient;
        if (path === "/billing/me") {
          return {
            billingStatus: entitlements().tier === "paid" ? "active" : entitlements().tier === "trial" ? "trialing" : "none",
            billingInterval: "monthly",
            seatCount: billingSeatCount,
            usedSeats: billingSeatCount,
            seatLimit: billingSeatLimit,
            hasStripeCustomer: entitlements().tier === "paid",
            hasStripeSubscription: entitlements().tier === "paid",
            currentPeriodEnd: null,
            proPricing: hostedClient.proPricing,
          };
        }
        if (path === "/clients/me/users") return orgUsersResponse;
        if (path === "/clients/me/guest-seats") return orgGuestSeatsResponse;
        if (path === "/clients/me/invites") return [];
        if (path === "/workspaces") return [{ id: "workspace-1", name: "Workspace" }];
        if (path === "/clients/me/archived-workspaces") return archivedWorkspacesResponse;
        if (path === "/clients/me/github-app/config") return githubConfigResponse;
        if (path === "/clients/me/github-app/installation") return githubInstallationResponse;
        if (path === "/notifications/settings") return notificationSettingsResponse;
        if (path === "/boards") return notificationBoardsResponse;
        return [];
      }),
      post: vi.fn(async () => ({ url: "https://checkout.stripe.test/session" })),
      patch: vi.fn(async (path: string) => path === "/notifications/settings" ? notificationSettingsResponse : {}),
      put: vi.fn(async (_path: string, body: Record<string, unknown>) => ({ workspaceId: "workspace-1", ...body })),
      delete: vi.fn(async () => ({})),
    };
    authRefresh = vi.fn(async () => "fresh-token");
    authSetSession = vi.fn();
    socketDisconnect = vi.fn();
    socket = new SocketStub();
    confirmOpen = vi.fn(async () => true);
    seatPaymentOpen = vi.fn(async () => ({ status: "succeeded" }));

    await TestBed.configureTestingModule({
      imports: [AccountSettingsPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api },
        {
          provide: AuthService,
          useValue: {
            user: user.asReadonly(),
            isOrgAdmin: isOrgAdmin.asReadonly(),
            isOrgOwner: signal(true).asReadonly(),
            entitlements: entitlements.asReadonly(),
            webhooksAllowed: computed(() => entitlements().webhooksAllowed),
            maxBoards: signal(null).asReadonly(),
            maxOrgMembers: maxOrgMembers.asReadonly(),
            updateUser: vi.fn(),
            refresh: authRefresh,
            setSession: authSetSession,
            broadcastLogout: vi.fn(),
            clearSession: vi.fn(),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: new Map() },
            get firstChild() {
              return { snapshot: { url: [{ path: activeSettingsRoute }] } };
            },
          },
        },
        { provide: Router, useValue: { navigate: routerNavigate } },
        { provide: ConfirmService, useValue: { open: confirmOpen } },
        { provide: OfflineCacheService, useValue: { clearAll: offlineCacheClear } },
        { provide: SeatPaymentService, useValue: { open: seatPaymentOpen } },
        {
          provide: BrowserPushService,
          useValue: {
            initialise: vi.fn(),
            loading: signal(false),
            busy: signal(false),
            unsupportedReason: signal(null),
            permission: signal("default"),
            statusMessage: vi.fn(() => ""),
            statusBadge: vi.fn(() => ""),
            permissionLabel: vi.fn(() => ""),
          },
        },
        { provide: SocketService, useValue: { connect: vi.fn(() => socket.asSocket()), joinWorkspace: vi.fn(() => vi.fn()), disconnect: socketDisconnect } },
        { provide: ThemeService, useValue: { theme: signal("dark"), setTheme: vi.fn() } },
      ],
    }).compileComponents();
  });

  async function createPage() {
    fixture = TestBed.createComponent(AccountSettingsPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => expect(fixture.componentInstance.client()).not.toBeNull());
    if (currentClient === hostedClient) {
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/billing/me"));
    }
    fixture.detectChanges();
  }

  async function navigateToSettingsRoute(route: string) {
    activeSettingsRoute = route;
    (fixture.componentInstance as unknown as { updateRouteTab: () => void }).updateRouteTab();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it("keeps the primary type table focused and collapses additional notification destinations", async () => {
    activeSettingsRoute = "notifications";
    await createPage();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/notifications/settings"));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("ntfy");
    expect(root.textContent).toContain("Gotify");
    expect(root.textContent).toContain("Personal webhook");
    expect(root.textContent).toContain("KANERA_ALLOW_PRIVATE_NOTIFICATION_DESTINATIONS=true");
    const additionalDestinations = root.querySelector<HTMLDetailsElement>(".additional-notification-destinations");
    expect(additionalDestinations?.open).toBe(false);

    fixture.componentInstance.ntfyServerUrl.set("https://ntfy.example.com");
    fixture.componentInstance.ntfyTopic.set("kanera");
    fixture.componentInstance.ntfyToken.set("secret-token");
    await fixture.componentInstance.savePersonalChannel("ntfy");

    expect(api.patch).toHaveBeenCalledWith("/notifications/settings", {
      personalChannels: { ntfy: { serverUrl: "https://ntfy.example.com", topic: "kanera", token: "secret-token" } },
    });
    const typeGrid = root.querySelector(".notification-grid");
    expect(typeGrid?.textContent).not.toContain("ntfy");
    expect(typeGrid?.textContent).not.toContain("Gotify");
    expect(typeGrid?.textContent).not.toContain("Webhook");
    expect(typeGrid?.querySelectorAll(".mini-toggle").length).toBe(10);
    expect(additionalDestinations?.querySelectorAll(".personal-channel-types .mini-toggle").length).toBe(15);
  });

  it("keeps email and browser push available while hiding Pro-only personal destinations on Free", async () => {
    entitlements.set({
      tier: "free",
      trialEndsAt: null,
      limited: true,
      maxBoards: 3,
      maxOrgMembers: 4,
      maxEnabledAutomations: 1,
      guestsAllowed: false,
      apiAllowed: false,
      webhooksAllowed: false,
    });
    activeSettingsRoute = "notifications";
    await createPage();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/notifications/settings"));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Allow email notifications");
    expect(root.textContent).toContain("Allow push notifications");
    expect(root.textContent).toContain("ntfy, Gotify, and personal webhooks aren't available on your plan");
    expect(root.querySelector(".personal-channel-list")).toBeNull();
  });

  it("renders, saves, and resets a workspace notification rule", async () => {
    activeSettingsRoute = "notifications";
    await createPage();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/boards"));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Workspace rules");
    expect(root.textContent).toContain("Using account defaults");
    expect(root.textContent).toContain("Add workspace rule");
    expect(root.querySelector(".workspace-rule-editor")).toBeNull();
    expect(root.querySelector(".workspace-rule-card")).toBeNull();

    const component = fixture.componentInstance;
    const group = component.notificationWorkspaceGroups()[0]!;
    component.editWorkspaceRule(group);
    component.setWorkspaceRuleChannel(group.workspaceId, "push", false);
    component.setWorkspaceRuleTypeChannel(group.workspaceId, "cardAssigned", "email", false);
    fixture.detectChanges();
    expect(root.textContent).toContain("This rule applies to every board in the workspace");
    await component.saveWorkspaceRule(group.workspaceId);

    expect(api.put).toHaveBeenCalledWith("/notifications/settings/workspaces/workspace-1", {
      paused: false,
      types: {
        cardAssigned: { email: false, push: false, ntfy: true, gotify: true, webhook: true },
        cardCommentAdded: { email: true, push: false, ntfy: true, gotify: true, webhook: true },
        commentMentioned: { email: true, push: false, ntfy: true, gotify: true, webhook: true },
        cardDueDateChanged: { email: true, push: false, ntfy: true, gotify: true, webhook: true },
        cardOverdue: { email: true, push: false, ntfy: true, gotify: true, webhook: true },
      },
    });
    expect(component.notificationSettings()?.workspaceRules).toHaveLength(1);
    fixture.detectChanges();
    expect(root.textContent).toContain("4/5 types");

    await component.resetWorkspaceRule(group.workspaceId);
    expect(api.delete).toHaveBeenCalledWith("/notifications/settings/workspaces/workspace-1");
    expect(component.notificationSettings()?.workspaceRules).toEqual([]);
  });

  it("only shows configured and enabled channels in the workspace rule editor", async () => {
    notificationSettingsResponse = {
      ...notificationSettingsResponse,
      personalChannels: {
        ...notificationSettingsResponse.personalChannels,
        ntfy: { ...notificationSettingsResponse.personalChannels.ntfy, configured: true, enabled: false },
      },
    };
    activeSettingsRoute = "notifications";
    await createPage();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/boards"));

    const component = fixture.componentInstance;
    component.editWorkspaceRule(component.notificationWorkspaceGroups()[0]!);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const editor = root.querySelector(".workspace-rule-editor");
    expect(editor).not.toBeNull();
    expect(editor?.textContent).toContain("Email");
    expect(editor?.textContent).not.toContain("Push");
    expect(editor?.textContent).not.toContain("ntfy");
    expect(editor?.textContent).not.toContain("Gotify");
    expect(editor?.textContent).not.toContain("Webhook");
    expect(editor?.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(editor?.querySelectorAll(".workspace-switch-control")).toHaveLength(0);
    expect(editor?.querySelectorAll(".workspace-matrix-checkbox")).toHaveLength(5);
    expect(editor?.querySelectorAll(".workspace-matrix-channel-heading input")).toHaveLength(1);
    expect(editor?.querySelector(".workspace-rule-pause-action")?.textContent).toContain("Pause");
    expect(editor?.textContent).toContain("Choose which types each available provider can deliver");
    expect(editor?.textContent).not.toContain("Boards allowed to notify you");
  });

  it("hides workspace rules when every outbound channel is unavailable", async () => {
    notificationSettingsResponse = {
      ...notificationSettingsResponse,
      emailEnabled: false,
      pushEnabled: false,
      push: { status: "system-disabled", registrationEnabled: false, enabled: false, publicKey: null },
      personalChannels: {
        ...notificationSettingsResponse.personalChannels,
        // A configured but disabled destination is still unavailable for workspace rules.
        ntfy: { ...notificationSettingsResponse.personalChannels.ntfy, configured: true, enabled: false },
      },
      workspaceRules: [{
        workspaceId: "workspace-1",
        paused: true,
        types: enabledWorkspaceRuleTypes(),
      }],
    };
    activeSettingsRoute = "notifications";
    await createPage();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector(".workspace-rules-block")).toBeNull();
    expect(root.textContent).not.toContain("Add workspace rule");
    // The section is only hidden; persisted rules remain available when a channel is re-enabled.
    expect(fixture.componentInstance.notificationSettings()?.workspaceRules).toHaveLength(1);
  });

  it("presents standalone boards separately without a redundant board scope", async () => {
    notificationBoardsResponse = [{
      id: "standalone-board-1",
      name: "Personal roadmap",
      workspaceId: "standalone-workspace-1",
      workspaceName: "Personal roadmap",
      workspaceKind: "board",
      clientId: "client-1",
      clientName: "Acme",
    }];
    notificationSettingsResponse = {
      ...notificationSettingsResponse,
      workspaceRules: [{
        workspaceId: "standalone-workspace-1",
        paused: false,
        types: enabledWorkspaceRuleTypes(),
      }],
    };
    activeSettingsRoute = "notifications";
    await createPage();

    const component = fixture.componentInstance;
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Standalone boards");
    expect(root.textContent).toContain("Email · This board");

    component.editWorkspaceRule(component.notificationWorkspaceGroups()[0]!);
    fixture.detectChanges();
    const editor = root.querySelector(".workspace-rule-editor");
    expect(editor?.textContent).not.toContain("Boards allowed to notify you");
    expect(editor?.textContent).toContain("This rule applies only to this standalone board");
  });

  it("rolls a workspace rule draft back when saving fails", async () => {
    activeSettingsRoute = "notifications";
    await createPage();
    const component = fixture.componentInstance;
    const group = component.notificationWorkspaceGroups()[0]!;
    component.setWorkspaceRuleTypeChannel(group.workspaceId, "cardAssigned", "email", false);
    api.put.mockRejectedValueOnce(new Error("Save failed"));

    await component.saveWorkspaceRule(group.workspaceId);

    expect(component.workspaceRuleDraft(group.workspaceId).types.cardAssigned.email).toBe(true);
    expect(component.notificationSettingsError()).toBe("Save failed");
  });

  it("renders org storage usage on the account plan tab", async () => {
    activeSettingsRoute = "account-plan";
    await createPage();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Storage");
    expect(text).toContain("512.0 MB of 1.0 GB used");
    expect(text).toContain("512.0 MB remaining");
  });

  it("renders the configured Free plan member limit in the plan comparison", async () => {
    activeSettingsRoute = "account-plan";
    await createPage();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("4 members");
  });

  it("renders build information in the settings shell", async () => {
    activeSettingsRoute = "profile";
    await createPage();

    const buildMeta = (fixture.nativeElement as HTMLElement).querySelector(".settings-build-meta");
    expect(buildMeta?.getAttribute("aria-label")).toBe("Build information");
    expect(buildMeta?.textContent).toContain("Version");
    expect(buildMeta?.textContent).toContain("Built");
  });

  it("opens cookie preferences from the profile tab without a floating control", async () => {
    activeSettingsRoute = "profile";
    const consent = TestBed.inject(CookieConsentService);
    consent.configure(true);
    await createPage();

    const root = fixture.nativeElement as HTMLElement;
    const button = Array.from(root.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.includes("Cookie settings")) as HTMLButtonElement;
    expect(button).toBeTruthy();
    const request = consent.settingsRequest();

    button.click();

    expect(consent.settingsRequest()).toBe(request + 1);
  });

  it("shows Upgrade on trial and posts the selected billing interval", async () => {
    billingSeatCount = 10;
    activeSettingsRoute = "account-plan";
    await createPage();

    const root = fixture.nativeElement as HTMLElement;
    const proCard = root.querySelector(".plan-card--pro");
    expect(proCard?.classList.contains("plan-card--current")).toBe(false);
    expect(proCard?.textContent).toContain("Trial access");
    expect(root.textContent).toContain("You are trialling Pro, not subscribed to it");
    expect(root.textContent).toContain("move to Kanera Basic");
    expect(root.textContent).not.toContain("Current plan");
    expect(root.textContent).toContain("Upgrade to Pro");
    expect(root.textContent).toContain("$50/mo total");
    expect(root.textContent).toContain("10 seats at $5/user/mo");
    expect(root.textContent).toContain("Save 18% ($11/user/year)");
    expect(root.textContent).not.toContain("Manage billing");

    const interval = Array.from(root.querySelectorAll(".billing-interval-card")).find((button) => button.textContent?.includes("Annual")) as HTMLButtonElement;
    interval.click();
    fixture.detectChanges();

    expect(root.textContent).toContain("$490 billed yearly");
    expect(root.textContent).toContain("$4.08/user/mo equivalent");
    // The Pro card price switches to the yearly per-seat total, not a "/mo" figure.
    expect(proCard?.textContent).toContain("$49/user/yr");

    const upgrade = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("Upgrade to Pro")) as HTMLButtonElement;
    upgrade.click();
    await fixture.whenStable();

    expect(api.post).toHaveBeenCalledWith("/billing/checkout", { interval: "annual", seatLimit: 10 });
    expect(authRefresh).not.toHaveBeenCalled();
  });

  it("starts Free checkout from used seats instead of the Free allowance", async () => {
    billingSeatCount = 2;
    billingSeatLimit = 4;
    activeSettingsRoute = "account-plan";
    entitlements.set({
      tier: "free",
      trialEndsAt: null,
      limited: true,
      maxBoards: 3,
      maxOrgMembers: 4,
      maxEnabledAutomations: 1,
      guestsAllowed: false,
      apiAllowed: false,
      webhooksAllowed: false,
    });
    await createPage();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("$10/mo total");
    expect(root.textContent).toContain("2 seats at $5/user/mo");

    const upgrade = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("Upgrade to Pro")) as HTMLButtonElement;
    upgrade.click();
    await fixture.whenStable();

    expect(api.post).toHaveBeenCalledWith("/billing/checkout", { interval: "monthly", seatLimit: 2 });
  });

  it("shows Manage billing on paid plans", async () => {
    activeSettingsRoute = "account-plan";
    await createPage();
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    await navigateToSettingsRoute("account-plan");

    const root = fixture.nativeElement as HTMLElement;
    const text = root.textContent ?? "";
    expect(text).toContain("Pro");
    expect(root.querySelector(".plan-card--pro")?.classList.contains("plan-card--current")).toBe(true);
    expect(text).toContain("Manage subscription & invoices");
    expect(text).toContain("Payment method");
    expect(text).toContain("You buy a pool of seats");
    expect(text).not.toContain("Upgrade to Pro");
  });

  it("posts the selected billing portal intent from paid plan actions", async () => {
    activeSettingsRoute = "account-plan";
    await createPage();
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    await navigateToSettingsRoute("account-plan");

    const root = fixture.nativeElement as HTMLElement;
    const clickByText = async (label: string) => {
      const button = Array.from(root.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label)) as HTMLButtonElement;
      expect(button).toBeTruthy();
      button.click();
      await fixture.whenStable();
      fixture.detectChanges();
    };

    await clickByText("Manage subscription & invoices");
    await clickByText("Payment method");

    expect(api.post).toHaveBeenCalledWith("/billing/portal", { intent: "invoices" });
    expect(api.post).toHaveBeenCalledWith("/billing/portal", { intent: "payment_method" });
  });

  it("does not allow manually entering fewer seats than are already used", async () => {
    activeSettingsRoute = "account-plan";
    billingSeatCount = 4;
    billingSeatLimit = 5;
    await createPage();
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    await navigateToSettingsRoute("account-plan");

    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>("input[aria-label='Purchased seats']");
    expect(input).toBeTruthy();
    expect(input!.min).toBe("4");

    fixture.componentInstance.decDesiredSeats();
    fixture.detectChanges();
    expect(fixture.componentInstance.desiredSeats()).toBe(4);
    expect(input!.value).toBe("4");

    input!.value = "1";
    input!.dispatchEvent(new Event("input"));
    fixture.detectChanges();

    expect(fixture.componentInstance.desiredSeats()).toBe(4);
    expect(input!.value).toBe("4");
  });

  it("offers payment-method recovery when a seat increase needs payment action", async () => {
    activeSettingsRoute = "account-plan";
    billingSeatCount = 2;
    billingSeatLimit = 2;
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    api.post
      .mockRejectedValueOnce(new ApiError(402, {
        code: "BILLING_PAYMENT_ACTION_REQUIRED",
        message: "Your payment method needs attention before we can add seats. Update your payment method, then try again.",
        portalIntent: "payment_method",
      }))
      .mockResolvedValueOnce({ url: "https://billing.stripe.test/payment-method" });
    await createPage();
    await navigateToSettingsRoute("account-plan");

    fixture.componentInstance.incDesiredSeats();
    fixture.detectChanges();
    const updateButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Update seats"));
    expect(updateButton).toBeTruthy();
    updateButton!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("We couldn't charge your payment method.");
    expect(fixture.componentInstance.seatNotice()?.kind).toBe("error");
    expect(fixture.componentInstance.seatNotice()?.action).toBe("payment_method");
    const paymentButton = Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Update payment method"));
    expect(paymentButton).toBeTruthy();

    paymentButton!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(api.post).toHaveBeenNthCalledWith(1, "/billing/seats", { seatLimit: 3 });
    expect(api.post).toHaveBeenNthCalledWith(2, "/billing/portal", { intent: "payment_method" });
  });

  it("confirms a paid seat increase before updating purchased seats", async () => {
    activeSettingsRoute = "account-plan";
    billingSeatCount = 2;
    billingSeatLimit = 2;
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    api.post
      .mockResolvedValueOnce({
        billingStatus: "active",
        billingInterval: "monthly",
        seatCount: 2,
        usedSeats: 2,
        seatLimit: 2,
        hasStripeCustomer: true,
        hasStripeSubscription: true,
        currentPeriodEnd: null,
        proPricing: hostedClient.proPricing,
        paymentConfirmation: { clientSecret: "pi_secret", publishableKey: "pk_test" },
      })
      .mockResolvedValueOnce({
        billingStatus: "active",
        billingInterval: "monthly",
        seatCount: 2,
        usedSeats: 2,
        seatLimit: 3,
        hasStripeCustomer: true,
        hasStripeSubscription: true,
        currentPeriodEnd: null,
        proPricing: hostedClient.proPricing,
      });
    await createPage();
    await navigateToSettingsRoute("account-plan");

    fixture.componentInstance.incDesiredSeats();
    fixture.detectChanges();
    const updateButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Update seats"));
    updateButton!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.post).toHaveBeenNthCalledWith(1, "/billing/seats", { seatLimit: 3 });
    expect(seatPaymentOpen).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: "pi_secret", publishableKey: "pk_test" }));
    expect(api.post).toHaveBeenNthCalledWith(2, "/billing/seats/confirm", {});
    expect(fixture.componentInstance.purchasedSeats()).toBe(3);
    expect(fixture.componentInstance.seatError()).toBeNull();
    expect(fixture.componentInstance.seatNotice()).toEqual({ kind: "success", message: "Payment confirmed. Seats have been added." });
  });

  it("keeps purchased seats unchanged while a seat payment is pending", async () => {
    activeSettingsRoute = "account-plan";
    billingSeatCount = 2;
    billingSeatLimit = 2;
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    seatPaymentOpen.mockResolvedValueOnce({ status: "pending" });
    api.post
      .mockResolvedValueOnce({
        billingStatus: "active",
        billingInterval: "monthly",
        seatCount: 2,
        usedSeats: 2,
        seatLimit: 2,
        hasStripeCustomer: true,
        hasStripeSubscription: true,
        currentPeriodEnd: null,
        proPricing: hostedClient.proPricing,
        paymentConfirmation: { clientSecret: "pi_secret", publishableKey: "pk_test" },
      })
      .mockResolvedValueOnce({
        billingStatus: "active",
        billingInterval: "monthly",
        seatCount: 2,
        usedSeats: 2,
        seatLimit: 3,
        hasStripeCustomer: true,
        hasStripeSubscription: true,
        currentPeriodEnd: null,
        proPricing: hostedClient.proPricing,
      });
    await createPage();
    await navigateToSettingsRoute("account-plan");

    fixture.componentInstance.incDesiredSeats();
    fixture.detectChanges();
    const updateButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Update seats"));
    updateButton!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith("/billing/seats", { seatLimit: 3 });
    expect(fixture.componentInstance.purchasedSeats()).toBe(2);
    expect(fixture.componentInstance.seatError()).toBeNull();
    expect(fixture.componentInstance.seatNotice()?.kind).toBe("info");
    expect(fixture.componentInstance.seatNotice()?.action).toBe("refresh_status");
    expect((fixture.nativeElement as HTMLElement).textContent).toContain("Payment submitted.");

    const refreshButton = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Refresh status"));
    expect(refreshButton).toBeTruthy();
    refreshButton!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.post).toHaveBeenNthCalledWith(2, "/billing/seats/confirm", {});
    expect(fixture.componentInstance.purchasedSeats()).toBe(3);
    expect(fixture.componentInstance.seatNotice()).toEqual({ kind: "success", message: "Payment confirmed. Seats have been added." });
  });

  it("keeps hosted billing out of the Organisation tab", async () => {
    activeSettingsRoute = "org";
    await createPage();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Organisation name");
    expect(text).not.toContain("GitHub App");
    expect(text).not.toContain("Enable push message");
    expect(text).not.toContain("Allow browser push for this organisation");
    expect(text).not.toContain("Current plan");
    expect(text).not.toContain("Upgrade to Pro");
    expect(text).not.toContain("Cancel plan");
  });

  it("requires the organisation name before requesting permanent deletion", async () => {
    activeSettingsRoute = "org";
    confirmOpen.mockResolvedValueOnce(false);
    await createPage();
    api.delete.mockClear();

    await fixture.componentInstance.deleteOrganisation();

    expect(confirmOpen).toHaveBeenCalledWith({
      title: 'Delete organisation "Acme"?',
      message: "This permanently deletes every workspace, standalone board, card, setting, and stored file.",
      confirmLabel: "Delete organisation",
      confirmationText: "Acme",
    });
    expect(api.delete).not.toHaveBeenCalled();
    expect(offlineCacheClear).not.toHaveBeenCalled();
  });

  it("clears offline organisation data before rendering the fallback organisation", async () => {
    activeSettingsRoute = "org";
    const fallbackUser = { ...user()!, clientId: "client-2", activeClientId: "client-2", orgName: "Fallback" };
    api.delete.mockResolvedValueOnce({ status: "authenticated", accessToken: "fallback-token", user: fallbackUser });
    await createPage();

    await fixture.componentInstance.deleteOrganisation();

    expect(api.delete).toHaveBeenCalledWith("/clients/me", { confirmationName: "Acme" });
    expect(socketDisconnect).toHaveBeenCalledOnce();
    expect(offlineCacheClear).toHaveBeenCalledOnce();
    expect(authSetSession).toHaveBeenCalledWith("fallback-token", fallbackUser);
  });

  it("shows hosted GitHub App installation when deployment credentials are configured", async () => {
    activeSettingsRoute = "org";
    githubConfigResponse = {
      configured: true,
      installUrl: "https://github.com/apps/kanera-board/installations/new",
      appSlug: "kanera-board",
      source: "env",
      pendingInstallation: true,
    };
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.githubAppConfig()?.configured).toBe(true));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const text = root.textContent ?? "";
    expect(api.get).toHaveBeenCalledWith("/clients/me/github-app/config");
    expect(api.get).toHaveBeenCalledWith("/clients/me/github-app/installation");
    expect(text).toContain("GitHub App");
    expect(text).toContain("Install the Kanera GitHub App for this organisation to enable private repository link previews.");
    expect(text).toContain("kanera-board");
    expect(text).toContain("Not installed");
    expect(text).not.toContain("GitHub organisation");
    expect(text).not.toContain("Set up GitHub access");
    expect(root.querySelector("a[href='https://github.com/apps/kanera-board/installations/new?state=org']")).toBeTruthy();
  });

  it("warns when a hosted GitHub installation has no selected private repositories", async () => {
    activeSettingsRoute = "org";
    githubConfigResponse = {
      configured: true,
      installUrl: "https://github.com/apps/kanera-board/installations/new",
      appSlug: "kanera-board",
      source: "env",
      pendingInstallation: false,
    };
    githubInstallationResponse = {
      id: "installation-row-1",
      clientId: "client-1",
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      repositories: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await createPage();
    await vi.waitFor(() => expect(fixture.componentInstance.githubInstallation()?.accountLogin).toBe("acme"));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const text = root.textContent ?? "";
    expect(text).toContain("acme");
    expect(text).toContain("No private repositories selected");
    expect(text).not.toContain("0 selected repositories");
    expect(root.querySelector(".source-badge.warning")).toBeTruthy();
    expect(root.querySelector("a[href='https://github.com/apps/kanera-board/installations/new?state=org']")).toBeTruthy();
    expect(text).toContain("Update access");
  });

  it("shows paid available seats in the Users tab", async () => {
    activeSettingsRoute = "users";
    billingSeatCount = 2;
    billingSeatLimit = 5;
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    await createPage();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("3 seats available");
    expect(text).toContain("2 of 5 used");
    expect(text).toContain("Pending invites do not reserve seats");
    expect(text).toContain("Manage seats");
  });

  it("refreshes the member roster and seat usage when an invite is accepted", async () => {
    activeSettingsRoute = "users";
    billingSeatCount = 1;
    billingSeatLimit = 2;
    entitlements.update((current) => ({ ...current, tier: "paid", trialEndsAt: null }));
    await createPage();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain("1 seat available");
    orgUsersResponse = [{
      id: "user-2",
      email: "invitee@example.com",
      displayName: "Invitee",
      avatarUrl: null,
      lastOnlineAt: null,
      role: "member",
      createdAt: new Date().toISOString(),
      suspendedAt: null,
      workspaces: [{ workspaceId: "workspace-1", workspaceName: "Workspace", role: "member" }],
    }];
    billingSeatCount = 2;

    socket.emitServer("client:user:added", {
      clientId: "client-1",
      user: {
        id: "user-2",
        email: "invitee@example.com",
        displayName: "Invitee",
        avatarUrl: null,
        role: "member",
        createdAt: new Date().toISOString(),
      },
    });

    await vi.waitFor(() => expect(fixture.componentInstance.orgUsers()).toHaveLength(1));
    await vi.waitFor(() => expect(fixture.componentInstance.usedSeats()).toBe(2));
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Invitee");
    expect(text).toContain("0 seats available");
    expect(text).toContain("2 of 2 used");
  });

  it("shows unlimited trial seats in the Users tab", async () => {
    activeSettingsRoute = "users";
    billingSeatCount = 6;
    billingSeatLimit = 6;
    await createPage();

    const root = fixture.nativeElement as HTMLElement;
    const text = root.textContent ?? "";
    expect(text).toContain("Trial seats");
    expect(text).toContain("Unlimited during trial");
    expect(text).toContain("6 seats currently in use");
    expect(text).not.toContain("0 seats available");
    expect(text).not.toContain("Manage seats");
    expect(root.querySelector(".user-seat-pool")?.classList.contains("user-seat-pool--full")).toBe(false);
  });

  it("shows the Free seat allowance in the Users tab", async () => {
    activeSettingsRoute = "users";
    billingSeatCount = 3;
    billingSeatLimit = 4;
    entitlements.set({
      tier: "free",
      trialEndsAt: null,
      limited: true,
      maxBoards: 3,
      maxOrgMembers: 4,
      maxEnabledAutomations: 1,
      guestsAllowed: false,
      apiAllowed: false,
      webhooksAllowed: false,
    });
    await createPage();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Free seats");
    expect(text).toContain("1 seat available");
    expect(text).toContain("3 of 4 used");
    expect(text).toContain("Upgrade plan");
  });

  it("shows external guests that consume seats in the Users tab", async () => {
    activeSettingsRoute = "users";
    orgGuestSeatsResponse = [{
      userId: "guest-1",
      email: "external@example.com",
      displayName: "External Guest",
      avatarUrl: null,
      lastOnlineAt: null,
      userClientId: "external-client",
      createdAt: new Date().toISOString(),
      boards: [
        {
          boardId: "board-1",
          boardName: "Roadmap",
          workspaceId: "workspace-1",
          workspaceName: "Client Work",
          role: "observer",
        },
        {
          boardId: "board-2",
          boardName: "Delivery",
          workspaceId: "workspace-1",
          workspaceName: "Client Work",
          role: "editor",
        },
      ],
    }];
    await createPage();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("External guest seats");
    expect(text).toContain("Manage guest access from the relevant workspace's Settings");
    expect(text).toContain("External Guest");
    expect(text).toContain("Seat used");
    expect(text).toContain("Client Work");
    expect(text).not.toContain("Roadmap");
    expect(text).not.toContain("observer");
  });

  it("requires confirmation before removing an organisation user", async () => {
    activeSettingsRoute = "users";
    orgUsersResponse = [
      {
        id: "user-2",
        email: "member@example.com",
        displayName: "Member",
        avatarUrl: null,
        role: "member",
        createdAt: new Date().toISOString(),
        suspendedAt: null,
        workspaces: [{ workspaceId: "workspace-1", workspaceName: "Workspace", role: "editor" }],
      },
    ];
    await createPage();

    confirmOpen.mockResolvedValueOnce(false);
    await fixture.componentInstance.removeOrgUser("user-2");
    expect(confirmOpen).toHaveBeenCalledWith({
      title: "Remove Member from the organisation?",
      message: "They will lose access to every workspace and board in this organisation.",
      confirmLabel: "Remove",
      danger: true,
    });
    expect(api.delete).not.toHaveBeenCalled();

    confirmOpen.mockResolvedValueOnce(true);
    await fixture.componentInstance.removeOrgUser("user-2");
    expect(api.delete).toHaveBeenCalledWith("/clients/me/users/user-2");
    expect(fixture.componentInstance.orgUsers()).toEqual([]);
  });

  it("orders organisation users by role and then display name", async () => {
    activeSettingsRoute = "users";
    orgUsersResponse = [
      { id: "member-z", email: "member-zoe@example.com", displayName: "Zoe", avatarUrl: null, role: "member", createdAt: new Date().toISOString(), suspendedAt: null, workspaces: [] },
      { id: "admin-z", email: "zara@example.com", displayName: "zara", avatarUrl: null, role: "admin", createdAt: new Date().toISOString(), suspendedAt: null, workspaces: [] },
      { id: "owner", email: "owner@example.com", displayName: "Owner", avatarUrl: null, role: "owner", createdAt: new Date().toISOString(), suspendedAt: null, workspaces: [] },
      { id: "admin-a", email: "ada@example.com", displayName: "Ada", avatarUrl: null, role: "admin", createdAt: new Date().toISOString(), suspendedAt: null, workspaces: [] },
      { id: "member-a", email: "member-amy@example.com", displayName: "Amy", avatarUrl: null, role: "member", createdAt: new Date().toISOString(), suspendedAt: null, workspaces: [] },
    ];
    await createPage();

    expect(fixture.componentInstance.filteredOrgUsers().map((orgUser) => orgUser.id)).toEqual([
      "owner",
      "admin-a",
      "admin-z",
      "member-a",
      "member-z",
    ]);

    fixture.componentInstance.orgUserSearch.set("member");
    expect(fixture.componentInstance.filteredOrgUsers().map((orgUser) => orgUser.id)).toEqual([
      "member-a",
      "member-z",
    ]);
  });

  it("hides hosted account management and plan-limit messaging in self-hosted mode", async () => {
    currentClient = selfHostedClient;
    user.update((current) => current ? { ...current, deploymentMode: "self_hosted" } : current);
    maxOrgMembers.set(1);
    orgUsersResponse = [
      {
        id: "user-1",
        email: "owner@example.com",
        displayName: "Owner",
        avatarUrl: null,
        role: "owner",
        createdAt: new Date().toISOString(),
        suspendedAt: null,
        workspaces: [{ workspaceId: "workspace-1", workspaceName: "Workspace", role: "owner" }],
      },
      {
        id: "user-2",
        email: "suspended@example.com",
        displayName: "Suspended User",
        avatarUrl: null,
        role: "member",
        createdAt: new Date().toISOString(),
        suspendedAt: new Date().toISOString(),
        workspaces: [],
      },
    ];
    archivedWorkspacesResponse = [{ id: "archived-1", name: "Archived", archivedAt: new Date().toISOString() }];

    activeSettingsRoute = "org";
    await createPage();

    let text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(api.get).not.toHaveBeenCalledWith("/billing/me");
    expect(text).not.toContain("Account Plan");
    expect(text).not.toContain("Current plan");
    expect(text).not.toContain("Upgrade to Pro");
    expect(text).not.toContain("Cancel plan");
    expect(text).toContain("GitHub App");
    expect(text).toContain("Enable push message");
    expect(text).toContain("Allow browser push for this organisation");
    expect(text).toContain("Storage");
    expect(text).toContain("SMTP");
    expect(text).toContain("Organisation name");

    await navigateToSettingsRoute("users");

    text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).not.toContain("You've reached your plan's member limit");
    expect(text).not.toContain("suspended by your plan");
    expect(text).not.toContain("Suspended");
    expect(text).not.toContain("Archived workspaces");
    expect(text).not.toContain("Stripe prorates them on your current billing plan");
    expect(text).toContain("Create invite");
  });

  it("redirects unavailable Account Plan deep links to Profile", async () => {
    currentClient = selfHostedClient;
    user.update((current) => current ? { ...current, deploymentMode: "self_hosted" } : current);

    activeSettingsRoute = "account-plan";
    await createPage();

    let text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Profile picture");
    expect(text).not.toContain("Account Plan");
    expect(routerNavigate).toHaveBeenCalledWith(["profile"], expect.objectContaining({
      replaceUrl: true,
    }));

    isOrgAdmin.set(false);
    user.update((current) => current ? { ...current, deploymentMode: "hosted", role: "member" } : current);
    currentClient = hostedClient;
    routerNavigate.mockClear();

    await navigateToSettingsRoute("account-plan");

    text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Profile picture");
    expect(text).not.toContain("Account Plan");
    expect(routerNavigate).toHaveBeenCalledWith(["profile"], expect.objectContaining({
      replaceUrl: true,
    }));
  });

  it("does not redirect after logout clears the user", async () => {
    activeSettingsRoute = "account-plan";
    await createPage();
    fixture.detectChanges();
    await fixture.whenStable();
    routerNavigate.mockClear();

    user.set(null);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(routerNavigate).not.toHaveBeenCalled();
  });

  it("verifies a new email before applying the change", async () => {
    emailVerificationEnabled = true;
    activeSettingsRoute = "profile";
    await createPage();
    const page = fixture.componentInstance;
    const auth = TestBed.inject(AuthService) as unknown as { updateUser: ReturnType<typeof vi.fn> };

    // Step 1: requesting a code must not apply the change yet.
    page.email.set("new@example.com");
    await page.requestEmailChange();
    expect(api.post).toHaveBeenCalledWith("/auth/me/email/request-verification", { email: "new@example.com" });
    expect(page.emailStep()).toBe("code");
    expect(auth.updateUser).not.toHaveBeenCalled();

    // Step 2: confirming with the code applies it.
    page.emailCode.set("123456");
    await page.confirmEmailChange();
    expect(api.post).toHaveBeenCalledWith("/auth/me/email", { email: "new@example.com", code: "123456" });
    expect(auth.updateUser).toHaveBeenCalled();
    expect(page.emailStep()).toBe("idle");
    expect(page.emailError()).toBeNull();
  });

  it("rejects a malformed verification code without calling the confirm endpoint", async () => {
    emailVerificationEnabled = true;
    activeSettingsRoute = "profile";
    await createPage();
    const page = fixture.componentInstance;

    page.email.set("new@example.com");
    page.emailStep.set("code");
    page.emailCode.set("12");
    await page.confirmEmailChange();

    expect(page.emailError()).toContain("6-digit");
    expect(api.post).not.toHaveBeenCalledWith("/auth/me/email", expect.anything());
  });

  it("saves a new email directly when verification is disabled", async () => {
    activeSettingsRoute = "profile";
    await createPage();
    const page = fixture.componentInstance;
    const auth = TestBed.inject(AuthService) as unknown as { updateUser: ReturnType<typeof vi.fn> };

    page.email.set("direct@example.com");
    await page.requestEmailChange();

    expect(api.post).toHaveBeenCalledWith("/auth/me/email", { email: "direct@example.com" });
    expect(api.post).not.toHaveBeenCalledWith("/auth/me/email/request-verification", expect.anything());
    expect(auth.updateUser).toHaveBeenCalled();
    expect(page.emailStep()).toBe("idle");
  });
});
