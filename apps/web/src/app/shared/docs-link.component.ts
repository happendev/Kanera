import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

/** Base of the published documentation site. Every in-app docs link resolves against this. */
export const KANERA_DOCS_URL = "https://www.kanera.app/docs";

/**
 * Every docs slug the app links to, mirroring the page ids in the Kanera-site `sidebars.ts`.
 *
 * Union-typed on purpose: a renamed or mistyped page becomes a build error here rather than a 404
 * the user discovers. When a doc page is renamed on the site, this list is the single place the
 * app has to follow it.
 */
export const DOCS_PATHS = [
  "ai-mcp-oauth",
  "ai-mcp-reference",
  "api",
  "automations",
  "board-health",
  "board-syncing",
  "boards",
  "card-labels",
  "chat-destinations",
  "checklist-templates",
  "completed-cards",
  "custom-fields",
  "guests",
  "lists",
  "managing-users",
  "notification-channels",
  "notification-configuration",
  "notification-workspace-rules",
  "organisations",
  "profile-security",
  "scratchpad",
  "trello-import",
  "user-roles",
  "webhooks",
  "workspace-users",
] as const;

export type DocsPath = (typeof DOCS_PATHS)[number];

/**
 * The inline "learn more" affordance that sits under a settings section's descriptive copy.
 *
 * Deliberately does not cover the two card/button-styled docs entry points (the API reference
 * banner and the agent "Setup guide" button) — those are different affordances that happen to
 * point at docs, and folding them in here would mean a variant input earning its keep twice.
 */
@Component({
  selector: "k-docs-link",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="docs-link" [href]="href()" target="_blank" rel="noopener noreferrer">
      {{ label() }} <i class="ti ti-external-link"></i>
    </a>
  `,
  styleUrl: "./docs-link.component.scss",
})
export class DocsLinkComponent {
  readonly path = input.required<DocsPath>();
  /** Heading anchor within the page, without the leading `#`. */
  readonly fragment = input<string | null>(null);
  readonly label = input.required<string>();

  readonly href = computed(() => {
    const fragment = this.fragment();
    return `${KANERA_DOCS_URL}/${this.path()}${fragment ? `#${fragment}` : ""}`;
  });
}
