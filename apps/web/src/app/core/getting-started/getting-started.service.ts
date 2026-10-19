import { Injectable, computed, inject, signal } from "@angular/core";
import type { GettingStartedUsedStep, HomeGettingStartedResponse, UpdateHomeGettingStartedBody } from "@kanera/shared/dto";
import { ApiClient } from "../api/api.client";

/**
 * The home "Getting started" checklist.
 *
 * Root-provided rather than owned by the home page because the command palette ticks a step from
 * anywhere in the app, and it often opens over home itself, where the tick should land live. The
 * shell also reads it: a checklist hidden from home lives on in the account menu as a progress ring.
 */
@Injectable({ providedIn: "root" })
export class GettingStartedService {
  private readonly api = inject(ApiClient);

  /** Null until the first load. */
  readonly state = signal<HomeGettingStartedResponse | null>(null);
  /** One write per step per app session is enough; the server stamps are one-way. */
  private readonly recorded = new Set<GettingStartedUsedStep>();

  private inflight: Promise<void> | null = null;

  /**
   * Progress for the account menu, shown whether or not the checklist is on home: the menu is the
   * one place it can always be reached from, and removed for good. A finished checklist has nothing
   * left to come back for, so it drops out of the menu.
   */
  readonly menuProgress = computed(() => {
    const state = this.state();
    if (!state || state.dismissed) return null;
    const total = state.steps.length;
    const done = state.steps.filter((step) => step.done).length;
    return done < total ? { done, total, percent: Math.round((done / total) * 100) } : null;
  });

  constructor() {
    // Hiding, reopening or finishing a step in another tab, on another device or from the CLI only
    // reaches this tab on return; refetch then, on whatever page the tab is showing, so the account
    // menu and home never act on the other tab's old state.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.state() && !this.state()!.dismissed) void this.load();
    });
  }

  /** Shared between the shell and home, which both ask on first paint. */
  load(): Promise<void> {
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(): Promise<void> {
    try {
      this.state.set(await this.api.get<HomeGettingStartedResponse>("/home/getting-started"));
    } catch {
      // Keep the last good state: the checklist is guidance, and a failed read must not blank home.
    }
  }

  /** Off home and into the account menu. Optimistic, like every write here. */
  hide(): void {
    this.state.update((state) => state && { ...state, hidden: true });
    void this.update({ hidden: true });
  }

  /** Back onto home, from the account menu. */
  show(): void {
    this.state.update((state) => state && { ...state, hidden: false });
    void this.update({ hidden: false });
  }

  /** Removed for good. A failed write only means it comes back next visit. */
  dismiss(): void {
    this.state.update((state) => state && { ...state, dismissed: true });
    void this.update({ dismissed: true });
  }

  /**
   * First use of a step that leaves no row behind: the palette opening (by shortcut or the sidebar's
   * search button, the same discovery), a filter applied, Work done opened, quick edit opened. Called
   * on every such use; skipped when the step is known to be done, so ordinary use costs no request.
   * Also sent before the state has loaded, since these can happen before home is ever visited.
   */
  noteUsed(key: GettingStartedUsedStep): void {
    const state = this.state();
    if (this.recorded.has(key) || state?.dismissed || state?.steps.some((step) => step.key === key && step.done)) return;
    this.recorded.add(key);
    this.state.update((current) => current && {
      ...current,
      steps: current.steps.map((step) => (step.key === key ? { ...step, done: true } : step)),
    });
    void this.update({ used: key });
  }

  private async update(body: UpdateHomeGettingStartedBody): Promise<void> {
    try {
      await this.api.patch<HomeGettingStartedResponse>("/home/getting-started", body);
    } catch {
      // Both writes are best-effort stamps; the next load shows the server's truth.
    }
  }
}
