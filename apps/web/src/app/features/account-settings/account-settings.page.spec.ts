import { provideZonelessChangeDetection, signal, type WritableSignal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import type { Entitlements } from "@kanera/shared/dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../../core/api/api.client";
import type { AuthUser } from "../../core/auth/auth.service";
import { AuthService } from "../../core/auth/auth.service";
import { BrowserPushService } from "../../core/notifications/browser-push.service";
import { SocketService } from "../../core/realtime/socket.service";
import { ThemeService } from "../../core/theme/theme.service";
import { ConfirmService } from "../../shared/confirm.service";
import { SeatPaymentService } from "../../shared/seat-payment.service";
import { AccountSettingsPage } from "./account-settings.page";

describe("AccountSettingsPage", () => {
  let fixture: ComponentFixture<AccountSettingsPage>;
  let entitlements: WritableSignal<Entitlements>;
  let maxOrgMembers: WritableSignal<number | null>;
  let api: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let confirmOpen: ReturnType<typeof vi.fn>;
  let seatPaymentOpen: ReturnType<typeof vi.fn>;
  let authRefresh: ReturnType<typeof vi.fn>;
  let user: WritableSignal<AuthUser | null>;
  let isOrgAdmin: WritableSignal<boolean>;
  let routerNavigate: ReturnType<typeof vi.fn>;
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
    proPricing: { monthlyCents: 400, annualCents: 300 },
    freePlanLimits: { maxBoards: 3, maxOrgMembers: 5, maxEnabledAutomations: 1 },
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
    currentClient = hostedClient;
    billingSeatCount = 1;
    billingSeatLimit = billingSeatCount;
    orgUsersResponse = [];
    orgGuestSeatsResponse = [];
    archivedWorkspacesResponse = [];
    emailVerificationEnabled = false;
    githubConfigResponse = { configured: false, installUrl: null, appSlug: null, source: null };
    githubInstallationResponse = null;
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
        return [];
      }),
      post: vi.fn(async () => ({ url: "https://checkout.stripe.test/session" })),
      patch: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    };
    authRefresh = vi.fn(async () => "fresh-token");
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
            maxBoards: signal(null).asReadonly(),
            maxOrgMembers: maxOrgMembers.asReadonly(),
            updateUser: vi.fn(),
            refresh: authRefresh,
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
        { provide: SocketService, useValue: { connect: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })), joinWorkspace: vi.fn(() => vi.fn()) } },
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
    expect(text).toContain("5 members");
  });

  it("renders build information in the settings shell", async () => {
    activeSettingsRoute = "profile";
    await createPage();

    const buildMeta = (fixture.nativeElement as HTMLElement).querySelector(".settings-build-meta");
    expect(buildMeta?.getAttribute("aria-label")).toBe("Build information");
    expect(buildMeta?.textContent).toContain("Version");
    expect(buildMeta?.textContent).toContain("Built");
  });

  it("shows Upgrade on trial and posts the selected billing interval", async () => {
    billingSeatCount = 10;
    activeSettingsRoute = "account-plan";
    await createPage();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("Upgrade to Pro");
    expect(root.textContent).toContain("$40/mo total");
    expect(root.textContent).toContain("10 seats at $4/user/mo");
    expect(root.textContent).toContain("Save 25% ($12/user/year)");
    expect(root.textContent).not.toContain("Manage billing");

    const interval = Array.from(root.querySelectorAll(".billing-interval-card")).find((button) => button.textContent?.includes("Annual")) as HTMLButtonElement;
    interval.click();
    fixture.detectChanges();

    expect(root.textContent).toContain("$360 billed yearly");
    expect(root.textContent).toContain("$3/user/mo equivalent");

    const upgrade = Array.from(root.querySelectorAll("button")).find((button) => button.textContent?.includes("Upgrade to Pro")) as HTMLButtonElement;
    upgrade.click();
    await fixture.whenStable();

    expect(api.post).toHaveBeenCalledWith("/billing/checkout", { interval: "annual", seatLimit: 10 });
    expect(authRefresh).not.toHaveBeenCalled();
  });

  it("starts Free checkout from used seats instead of the Free allowance", async () => {
    billingSeatCount = 2;
    billingSeatLimit = 5;
    activeSettingsRoute = "account-plan";
    entitlements.set({
      tier: "free",
      trialEndsAt: null,
      limited: true,
      maxBoards: 3,
      maxOrgMembers: 5,
      maxEnabledAutomations: 1,
      guestsAllowed: false,
      apiAllowed: false,
      webhooksAllowed: false,
    });
    await createPage();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain("$8/mo total");
    expect(root.textContent).toContain("2 seats at $4/user/mo");

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
    billingSeatLimit = 5;
    entitlements.set({
      tier: "free",
      trialEndsAt: null,
      limited: true,
      maxBoards: 3,
      maxOrgMembers: 5,
      maxEnabledAutomations: 1,
      guestsAllowed: false,
      apiAllowed: false,
      webhooksAllowed: false,
    });
    await createPage();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
    expect(text).toContain("Free seats");
    expect(text).toContain("2 seats available");
    expect(text).toContain("3 of 5 used");
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
