import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { UpgradeSource } from "../../core/analytics/analytics-events";
import { ApiClient } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { buildAgentSetupPrompt } from "../agent-setup-prompt";
import { KANERA_DOCS_URL } from "../docs-link.component";
import { TooltipDirective } from "../tooltip.directive";
import { UpgradePromptService } from "../upgrade-prompt.service";

/** How long the "copied" confirmation replaces a button label before it resets. */
const COPIED_RESET_MS = 2500;

/**
 * "Connect an AI agent": the MCP address plus the one-paste setup prompt, shared by the blank home
 * page and the personal API-keys settings tab so the copy, clipboard handling, and Pro gate cannot
 * drift between them. The agent connects through OAuth, so no key is created here.
 */
@Component({
  selector: "k-agent-connect-card",
  standalone: true,
  imports: [RouterLink, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./agent-connect-card.component.html",
  styleUrl: "./agent-connect-card.component.scss",
})
export class AgentConnectCardComponent implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly auth = inject(AuthService);
  private readonly upgradePrompt = inject(UpgradePromptService);
  private readonly destroyRef = inject(DestroyRef);

  /** Where the card is rendered; forwarded to the upgrade prompt for attribution. */
  readonly source = input.required<UpgradeSource>();
  /** Hide the card's own heading and intro when the host already provides a section title. */
  readonly compact = input(false);
  /** Link to the settings tab that lists connected agents and personal keys. */
  readonly showManageLink = input(true);

  readonly mcpUrl = signal("");
  readonly loading = signal(true);
  readonly copied = signal<"prompt" | "url" | null>(null);
  // The server refuses OAuth consent on plans without API access, so surface the gate here rather
  // than letting the agent fail at the consent screen.
  readonly apiAllowed = this.auth.apiAllowed;
  readonly isHosted = computed(() => this.auth.user()?.deploymentMode === "hosted");
  readonly docsUrl = `${KANERA_DOCS_URL}/ai-mcp-oauth`;

  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.resetTimer) clearTimeout(this.resetTimer);
    });
  }

  async ngOnInit() {
    const config = await this.api.get<{ mcpUrl: string }>("/me/agent-connection-config").catch(() => ({ mcpUrl: "" }));
    this.mcpUrl.set(config.mcpUrl ?? "");
    this.loading.set(false);
  }

  async copyPrompt() {
    const url = this.mcpUrl();
    if (!url) return;
    await this.copy(buildAgentSetupPrompt(url), "prompt");
  }

  async copyUrl() {
    const url = this.mcpUrl();
    if (!url) return;
    await this.copy(url, "url");
  }

  upgrade(): void {
    void this.upgradePrompt.open({ reason: "api", source: this.source() });
  }

  private async copy(text: string, what: "prompt" | "url") {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text);
    this.copied.set(what);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.copied.set(null), COPIED_RESET_MS);
  }
}
