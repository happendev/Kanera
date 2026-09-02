import { provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { buildAgentSetupPrompt } from "../agent-setup-prompt";
import { UpgradePromptService } from "../upgrade-prompt.service";
import { AgentConnectCardComponent } from "./agent-connect-card.component";

describe("AgentConnectCardComponent", () => {
  let fixture: ComponentFixture<AgentConnectCardComponent>;
  const writeText = vi.fn(async () => undefined);
  const upgradeOpen = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  async function render(options: { mcpUrl?: string | null; apiAllowed?: boolean; compact?: boolean; showManageLink?: boolean } = {}) {
    const get = vi.fn(async (path: string) => {
      if (path === "/me/agent-connection-config") {
        if (options.mcpUrl === null) throw new Error("unavailable");
        return { mcpUrl: options.mcpUrl ?? "https://mcp.example.test/mcp" };
      }
      return {};
    });
    await TestBed.configureTestingModule({
      imports: [AgentConnectCardComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiClient, useValue: { get } },
        {
          provide: AuthService,
          useValue: {
            user: signal({ id: "user-1", clientId: "client-1", deploymentMode: "hosted" }),
            apiAllowed: signal(options.apiAllowed ?? true),
          },
        },
        { provide: UpgradePromptService, useValue: { open: upgradeOpen } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AgentConnectCardComponent);
    fixture.componentRef.setInput("source", "home");
    if (options.compact !== undefined) fixture.componentRef.setInput("compact", options.compact);
    if (options.showManageLink !== undefined) fixture.componentRef.setInput("showManageLink", options.showManageLink);
    fixture.detectChanges();
    await settle();
    return { get };
  }

  /** The MCP address arrives from an awaited fetch in ngOnInit; flush a macrotask before asserting. */
  async function settle(): Promise<void> {
    // whenStable() schedules through real timers, so under fake timers flush the queue directly.
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
    }
    fixture.detectChanges();
  }

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function buttonWithText(label: string): HTMLButtonElement | undefined {
    return [...host().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(label));
  }

  it("renders the MCP address and copies the one-paste setup prompt built from it", async () => {
    await render();
    vi.useFakeTimers();

    expect(host().textContent).toContain("Connect an AI agent");
    expect(host().querySelector(".agent-card-address code")?.textContent).toBe("https://mcp.example.test/mcp");
    expect(host().querySelector("a[href='/settings/api-keys']")).not.toBeNull();

    buttonWithText("Copy agent setup prompt")!.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(buildAgentSetupPrompt("https://mcp.example.test/mcp"));
    expect(host().textContent).toContain("Setup prompt copied");

    // The confirmation is transient so the button reads as an action again.
    await vi.advanceTimersByTimeAsync(3000);
    fixture.detectChanges();
    expect(host().textContent).toContain("Copy agent setup prompt");
  });

  it("copies the bare MCP address separately", async () => {
    await render();
    host().querySelector<HTMLButtonElement>("button[aria-label='Copy MCP address']")!.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("https://mcp.example.test/mcp");
  });

  it("falls back to the setup guide when the MCP address is unavailable", async () => {
    await render({ mcpUrl: null });
    expect(buttonWithText("Copy agent setup prompt")).toBeUndefined();
    expect(host().querySelector(".agent-card-address")).toBeNull();
    expect(host().textContent).toContain("Setup guide");
  });

  it("shows the Pro callout and opens the upgrade prompt when the plan lacks API access", async () => {
    await render({ apiAllowed: false });
    expect(host().textContent).toContain("Connecting an AI agent is part of Kanera Pro");
    expect(buttonWithText("Copy agent setup prompt")).toBeUndefined();

    buttonWithText("See Pro")!.click();
    expect(upgradeOpen).toHaveBeenCalledWith({ reason: "api", source: "home" });
  });

  it("drops its own heading and manage link when embedded under a host section title", async () => {
    await render({ compact: true, showManageLink: false });
    expect(host().querySelector(".agent-card-header")).toBeNull();
    expect(host().querySelector("a[href='/settings/api-keys']")).toBeNull();
    expect(host().querySelector(".agent-card.is-compact")).not.toBeNull();
  });
});
