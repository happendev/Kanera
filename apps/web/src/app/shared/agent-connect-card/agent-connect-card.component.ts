import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiClient } from "../../core/api/api.client";
import { buildAgentSetupPrompt } from "../agent-setup-prompt";
import { AGENT_SNIPPET_CLIENTS, buildAgentSetupSnippet, type AgentSnippetClient } from "../agent-setup-snippets";
import { KANERA_DOCS_URL } from "../docs-link.component";
import { TooltipDirective } from "../tooltip.directive";

/** How long the "copied" confirmation replaces a button label before it resets. */
const COPIED_RESET_MS = 2500;

/**
 * "Connect an AI agent": the MCP address plus the one-paste setup prompt, shared by the blank home
 * page and the personal API-keys settings tab so the copy and clipboard handling cannot drift
 * between them. The agent connects through OAuth, so no key is created here. Interactive agent
 * connections are available on every plan (Free is metered by fair-use limits server-side), so the
 * card has no plan gate.
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
  private readonly destroyRef = inject(DestroyRef);

  /** Hide the card's own heading and intro when the host already provides a section title. */
  readonly compact = input(false);
  /** Link to the settings tab that lists connected agents and personal keys. */
  readonly showManageLink = input(true);
  /** Show per-client config snippets for people who prefer to configure their agent by hand. */
  readonly showSnippets = input(false);

  readonly mcpUrl = signal("");
  readonly loading = signal(true);
  readonly copied = signal<"prompt" | "url" | "snippet" | null>(null);
  readonly snippetClients = AGENT_SNIPPET_CLIENTS;
  readonly snippetClient = signal<AgentSnippetClient>("claude-code");
  readonly snippet = computed(() => {
    const url = this.mcpUrl();
    return url ? buildAgentSetupSnippet(this.snippetClient(), url) : null;
  });
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

  async copySnippet() {
    const snippet = this.snippet();
    if (!snippet) return;
    await this.copy(snippet.code, "snippet");
  }

  private async copy(text: string, what: "prompt" | "url" | "snippet") {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text);
    this.copied.set(what);
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.copied.set(null), COPIED_RESET_MS);
  }
}
