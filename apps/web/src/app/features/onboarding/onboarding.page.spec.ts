import { provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import type { Board, Workspace } from "@kanera/shared/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import type { AuthUser } from "../../core/auth/auth.service";
import { AuthService } from "../../core/auth/auth.service";
import { SocketService } from "../../core/realtime/socket.service";
import { OnboardingPage } from "./onboarding.page";

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "user-1",
    clientId: "client-1",
    email: "me@example.com",
    displayName: "Me User",
    avatarUrl: null,
    orgName: "Kanera",
    logoUrl: null,
    deploymentMode: "self_hosted",
    hasWorkspace: false,
    role: "owner",
    timezone: "UTC",
    ...overrides,
  };
}

function workspace(): Workspace {
  return {
    id: "workspace-1",
    clientId: "client-1",
    name: "My workspace",
    icon: "rocket",
    accentColor: null,
    completedCardsActiveDays: 35,
    createdAt: new Date("2026-05-28T00:00:00.000Z"),
    updatedAt: new Date("2026-05-28T00:00:00.000Z"),
    archivedAt: null,
  };
}

function starterList(): Board {
  return {
    id: "list-1",
    workspaceId: "workspace-1",
    groupId: null,
    name: "Engineering",
    description: null,
    icon: "code",
    iconColor: null,
    backgroundGradient: null,
    position: "1000.0000000000",
    archivedAt: null,
    createdAt: new Date("2026-05-28T00:00:00.000Z"),
    updatedAt: new Date("2026-05-28T00:00:00.000Z"),
  };
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function render(overrides: {
    user?: AuthUser;
    maxBoards?: ReturnType<typeof signal<number | null>>;
    get?: ReturnType<typeof vi.fn>;
    post?: ReturnType<typeof vi.fn>;
    navigateByUrl?: ReturnType<typeof vi.fn>;
  } = {}) {
    const user = signal(overrides.user ?? authUser());
    const maxBoards = overrides.maxBoards ?? signal<number | null>(null);
    const refresh = vi.fn();
    const updateUser = vi.fn((mutator: (current: AuthUser) => AuthUser) => user.set(mutator(user()!)));
    const get = overrides.get ?? vi.fn(() => Promise.resolve({ groups: [] }));
    const post = overrides.post ?? vi.fn(() => Promise.resolve({ ...workspace(), initialBoard: starterList() }));
    const navigateByUrl = overrides.navigateByUrl ?? vi.fn(() => Promise.resolve(true));

    await TestBed.configureTestingModule({
      imports: [OnboardingPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiClient, useValue: { get, post } },
        {
          provide: AuthService,
          useValue: {
            user,
            isOrgAdmin: signal(true),
            maxBoards,
            refresh,
            updateUser,
          },
        },
        { provide: Router, useValue: { navigateByUrl } },
        { provide: SocketService, useValue: { connect: vi.fn() } },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(OnboardingPage);
    return { fixture, component: fixture.componentInstance, get, post, navigateByUrl, refresh, user, maxBoards };
  }

  it("selects the Development Team template by default", async () => {
    const { component } = await render();

    expect(component.selectedTemplateId()).toBe("development-team");
    expect(component.name()).toBe("Development");
    expect(component.icon()).toBe("code");
    expect(component.lists().map((list) => list.name)).toEqual([
      "Wishlist",
      "Planning / Review",
      "Backlog",
      "Bugs / Issues / Feedback",
      "Awaiting Feedback",
      "In Progress",
      "Ready for QA",
      "Complete",
    ]);
    expect(component.fields().map((field) => field.name)).toEqual(["Branch", "Billing Hours", "Billing Month"]);
    expect(component.labels().map((label) => label.name)).toEqual([
      "Support",
      "Reporting",
      "Issue / Bug",
      "Chore",
      "Feature / Enhancement",
    ]);
  });

  it("renders configured list icons on the workflow step", async () => {
    const { component, fixture } = await render();

    component.step.set(4);
    fixture.detectChanges();

    const icons = Array.from(fixture.nativeElement.querySelectorAll(".ob-item .ob-icon")) as HTMLElement[];
    expect(icons.map((icon) => icon.className)).toEqual([
      "ob-icon ti ti-star",
      "ob-icon ti ti-clipboard-list",
      "ob-icon ti ti-list",
      "ob-icon ti ti-bug",
      "ob-icon ti ti-message-dots",
      "ob-icon ti ti-progress",
      "ob-icon ti ti-checklist",
      "ob-icon ti ti-circle-check",
    ]);
  });

  it("teaches the shared workspace model before setup", async () => {
    const { component, fixture } = await render();
    fixture.detectChanges();

    const content = fixture.nativeElement.textContent as string;
    expect(content).toContain("Boards in a workspace share one setup");
    expect(content).toContain("Group similar work into one workspace, such as a team, department, or client group.");
    expect(content).toContain("Shared setup");
    expect(content).toContain("Custom fields");
    expect(content).toContain("Labels");
    expect(content).toContain("see assigned work, filter, and report across the whole workspace");

    component.step.set(2);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain("What type of work are you doing?");
  });

  it("selecting Marketing replaces workspace setup drafts", async () => {
    const { component } = await render();

    component.selectTemplate("marketing");

    expect(component.selectedTemplateId()).toBe("marketing");
    expect(component.name()).toBe("Marketing");
    expect(component.icon()).toBe("speakerphone");
    expect(component.lists().map((list) => list.name)).toEqual([
      "Ideas",
      "Briefing",
      "Copy / Creative",
      "Review",
      "Scheduled",
      "Live",
      "Reporting",
    ]);
    expect(component.fields().map((field) => field.name)).toEqual([
      "Channel",
      "Campaign",
      "Launch Date",
      "Budget",
      "Asset URL",
      "Approved",
    ]);
    expect(component.labels().map((label) => label.name)).toEqual([
      "Campaign",
      "Social",
      "Email",
      "Content",
      "Paid",
      "Event",
    ]);
  });

  it("selecting Blank clears setup drafts and can finish without an initial board or lists", async () => {
    const post = vi.fn(() => Promise.resolve(workspace()));
    const { component, navigateByUrl } = await render({ post });

    component.selectTemplate("blank");

    expect(component.selectedTemplateId()).toBe("blank");
    expect(component.name()).toBe("Workspace");
    expect(component.icon()).toBe("layout-kanban");
    expect(component.lists()).toEqual([]);
    expect(component.fields()).toEqual([]);
    expect(component.labels()).toEqual([]);
    expect(component.canContinueFromLists()).toBe(true);

    await component.finish();

    expect(post).toHaveBeenCalledOnce();
    const payload = (post.mock.calls as unknown as [string, unknown][])[0]![1];
    expect(payload).toEqual({
      name: "Workspace",
      icon: "layout-kanban",
      lists: [],
      customFields: [],
      labels: [],
    });
    expect(navigateByUrl).toHaveBeenCalledWith("/", { replaceUrl: true });
  });

  it("posts selected template options for select fields", async () => {
    const { component, post } = await render();
    component.selectTemplate("marketing");

    await component.finish();

    expect(post).toHaveBeenCalledOnce();
    const payload = post.mock.calls[0]![1] as {
      initialBoard: { name: string; icon: string };
      lists: { name: string; icon: string | null }[];
      customFields: { name: string; options?: { label: string }[] }[];
    };
    expect(payload.initialBoard).toEqual({ name: "Campaigns", icon: "speakerphone" });
    expect(payload.lists.map((list) => [list.name, list.icon])).toEqual([
      ["Ideas", "bulb"],
      ["Briefing", "clipboard"],
      ["Copy / Creative", "pencil"],
      ["Review", "eye"],
      ["Scheduled", "calendar-event"],
      ["Live", "broadcast"],
      ["Reporting", "chart-bar"],
    ]);
    expect(payload.customFields.find((field) => field.name === "Channel")?.options?.map((option) => option.label)).toEqual([
      "Social",
      "Email",
      "Paid",
      "Content",
      "Event",
    ]);
  });

  it("posts custom field option edits and multi-value settings from onboarding", async () => {
    const { component, post } = await render();
    component.selectTemplate("simple-todo");

    const priority = component.fields().find((field) => field.name === "Priority")!;
    const high = priority.options!.find((option) => option.label === "High")!;
    component.renameOption(priority.id, high.id, "Urgent");
    component.recolorOption(priority.id, high.id, "rose");
    component.setNewOptionLabel(priority.id, "Someday");
    component.setNewOptionColor(priority.id, "gray");
    component.addOption(priority.id);

    component.newField.set("Owner");
    component.newFieldType.set("user");
    component.newFieldAllowMultiple.set(true);
    component.addField();

    await component.finish();

    const payload = post.mock.calls[0]![1] as { customFields: { name: string; allowMultiple: boolean; options?: { label: string; color?: string | null }[] }[] };
    expect(payload.customFields.find((field) => field.name === "Priority")?.options).toContainEqual({ label: "Urgent", color: "rose" });
    expect(payload.customFields.find((field) => field.name === "Priority")?.options).toContainEqual({ label: "Someday", color: "gray" });
    expect(payload.customFields.find((field) => field.name === "Owner")?.allowMultiple).toBe(true);
  });

  it("does not overwrite a manually edited workspace name when changing templates", async () => {
    const { component } = await render();

    component.setWorkspaceName("Acme Launch Room");
    component.selectTemplate("marketing");

    expect(component.name()).toBe("Acme Launch Room");
    expect(component.icon()).toBe("code");
    expect(component.lists()[0]?.name).toBe("Ideas");
  });

  it("does not refresh the session after creating the first workspace", async () => {
    const { component, post, navigateByUrl, refresh, user } = await render();

    await component.finish();

    expect(post).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(user()?.hasWorkspace).toBe(true);
    expect(navigateByUrl).toHaveBeenCalledWith("/b/list-1", { replaceUrl: true });
  });

  it("blocks onboarding setup while the board limit is reached and re-enables after upgrade", async () => {
    const maxBoards = signal<number | null>(1);
    const get = vi.fn(() => Promise.resolve({ groups: [{ boards: [{ id: "board-1" }] }] }));
    const { component, fixture, post } = await render({ maxBoards, get });

    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.boardLimitReached()).toBe(true);
    component.newList.set("Blocked list");
    component.addList();
    expect(component.lists().some((list) => list.name === "Blocked list")).toBe(false);

    await component.finish();
    expect(post).not.toHaveBeenCalled();
    expect(component.error()).toContain("Your plan allows 1 board");

    maxBoards.set(null);
    component.newList.set("Allowed list");
    component.addList();
    await component.finish();

    expect(component.boardLimitReached()).toBe(false);
    expect(component.lists().some((list) => list.name === "Allowed list")).toBe(true);
    expect(post).toHaveBeenCalledOnce();
  });
});
