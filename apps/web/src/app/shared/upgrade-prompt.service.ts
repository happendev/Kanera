import { ApplicationRef, createComponent, EnvironmentInjector, inject, Injectable, type ComponentRef } from "@angular/core";
import { Router } from "@angular/router";
import type { BillingInfoResponse } from "@kanera/shared/dto";
import { ApiClient } from "../core/api/api.client";
import { AuthService } from "../core/auth/auth.service";
import { UpgradePromptDialogComponent, type UpgradePromptContent } from "./upgrade-prompt-dialog.component";

export type UpgradePromptReason = "member" | "board" | "automation" | "automationRule" | "guest" | "api" | "integration";

export interface UpgradePromptOptions {
  reason: UpgradePromptReason;
  /** Include the attempted addition when quoting a seat-gated action. */
  projectedSeats?: number;
  boardCount?: number;
  automationAllowance?: number;
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

@Injectable({ providedIn: "root" })
export class UpgradePromptService {
  private readonly api = inject(ApiClient);
  private readonly appRef = inject(ApplicationRef);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(EnvironmentInjector);
  private readonly router = inject(Router);
  private openDialog: ComponentRef<UpgradePromptDialogComponent> | null = null;

  async open(options: UpgradePromptOptions): Promise<void> {
    if (this.openDialog || this.auth.entitlements()?.tier === "paid") return;

    const canReviewPlan = this.auth.isOrgAdmin();
    const billing = canReviewPlan ? await this.api.get<BillingInfoResponse>("/billing/me").catch(() => null) : null;
    const currentSeats = billing?.usedSeats ?? 1;
    const seats = Math.max(1, options.projectedSeats ?? (options.reason === "guest" ? currentSeats + 1 : currentSeats));
    const annualCents = billing?.proPricing?.annualCents;
    const monthlyEquivalent = annualCents === undefined ? null : Math.round((annualCents * seats) / 12);
    const cost = !canReviewPlan
      ? "Ask your organisation owner to review Pro and your team's exact price."
      : monthlyEquivalent === null
      ? "See the Account Plan page for your exact team price."
      : `${money(monthlyEquivalent)}/month for ${seats} ${seats === 1 ? "person" : "people"} on annual billing (${money(annualCents! * seats)} billed yearly).`;
    const content = { ...this.content(options, seats, monthlyEquivalent, cost), canReviewPlan };

    const ref = createComponent(UpgradePromptDialogComponent, { environmentInjector: this.injector });
    this.openDialog = ref;
    ref.setInput("content", content);
    const close = () => {
      if (this.openDialog !== ref) return;
      this.openDialog = null;
      this.appRef.detachView(ref.hostView);
      ref.destroy();
    };
    ref.instance.dismissed.subscribe(close);
    ref.instance.reviewPlan.subscribe(() => {
      close();
      if (canReviewPlan) void this.router.navigate(["/settings", "account-plan"], { queryParams: { billing: "annual" } });
    });
    this.appRef.attachView(ref.hostView);
    document.body.appendChild(ref.location.nativeElement);
  }

  private content(options: UpgradePromptOptions, seats: number, monthlyEquivalent: number | null, cost: string): Omit<UpgradePromptContent, "canReviewPlan"> {
    const teamHeadline = monthlyEquivalent === null
      ? `Bring your full ${seats}-person team into Kanera with Pro.`
      : `Your full ${seats}-person team costs ${money(monthlyEquivalent)}/month on annual billing.`;
    switch (options.reason) {
      case "member":
        return {
          headline: teamHeadline,
          attemptedAction: "Invite another editor",
          valueReceived: `${Math.max(0, seats - 1)} people already share your organisation's boards, fields, and workflow.`,
          cost,
          freeConsequence: `Your team stays at ${Math.max(0, seats - 1)} active people and this invitation cannot add another editor.`,
        };
      case "board": {
        const boardCount = options.boardCount ?? 0;
        return {
          headline: "Move from a pilot to running all your projects in Kanera.",
          attemptedAction: "Create another board",
          valueReceived: `Your team already runs ${boardCount} active project${boardCount === 1 ? "" : "s"} in one shared workflow.`,
          cost,
          freeConsequence: "Your current boards stay available, but this new board will not be created.",
        };
      }
      case "automation": {
        const allowance = options.automationAllowance ?? 100;
        return {
          headline: `Kanera automated ${allowance} actions for your team this month.`,
          attemptedAction: "Run another automation",
          valueReceived: `${allowance} repetitive actions were handled automatically this month.`,
          cost,
          freeConsequence: "Enabled rules stay configured, but further automation actions wait until next month's allowance resets.",
        };
      }
      case "automationRule":
        return {
          headline: "Run every workflow your team needs with Pro.",
          attemptedAction: "Enable another automation",
          valueReceived: "Your active rules already take repeatable work off your team's plate.",
          cost,
          freeConsequence: "Existing enabled rules keep running within the monthly allowance, but this additional rule stays paused.",
        };
      case "guest":
        return {
          headline: "Collaborate with this client across projects with Pro.",
          attemptedAction: "Add a multi-board guest",
          valueReceived: "The client relationship and project work already live in Kanera.",
          cost,
          freeConsequence: "The guest keeps their existing access, but cannot be added across more projects.",
        };
      case "api":
        return {
          headline: "Connect Kanera to your systems and AI agents with Pro.",
          attemptedAction: "Open API or MCP setup",
          valueReceived: "Your boards and workflows are ready to become the source for connected systems and agents.",
          cost,
          freeConsequence: "Your work stays in Kanera, but API keys, webhooks, and MCP connections remain unavailable.",
        };
      case "integration":
        return {
          headline: "Bring Kanera updates into the chat where your team already works.",
          attemptedAction: "Connect a chat destination",
          valueReceived: "Your workspace already has the card activity your team needs to follow.",
          cost,
          freeConsequence: "Work stays available in Kanera, but updates will not post to Slack, Discord, Telegram, or Zulip.",
        };
    }
  }
}
