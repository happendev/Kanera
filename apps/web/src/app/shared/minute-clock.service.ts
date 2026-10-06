import { Injectable, signal } from "@angular/core";

/**
 * One app-wide "now" that advances once a minute, for labels that age in place (time in progress).
 *
 * A single root interval instead of one per tile: a board can render thousands of cards, and each
 * reads this signal only inside a computed, so a tick re-evaluates just the labels that depend on it.
 */
@Injectable({ providedIn: "root" })
export class MinuteClockService {
  private readonly nowMs = signal(Date.now());
  readonly now = this.nowMs.asReadonly();

  constructor() {
    if (typeof window === "undefined") return;
    window.setInterval(() => this.nowMs.set(Date.now()), 60_000);
  }
}
