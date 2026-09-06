import { Directive, signal } from "@angular/core";
import type { OnDestroy, OnInit } from "@angular/core";

const PULSE_INTERVAL_MS = 30_000;
const PULSE_DURATION_MS = 4_000;

/** Mounted only while there are unread notifications, so reading them also cancels the timer. */
@Directive({
  selector: "[kUnreadGlow]",
  host: { "[class.is-pulsing]": "pulsing()" },
})
export class UnreadGlowDirective implements OnInit, OnDestroy {
  readonly pulsing = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private motion: MediaQueryList | null = null;

  ngOnInit(): void {
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.motion.addEventListener("change", this.restart);
    document.addEventListener("visibilitychange", this.restart);
    this.restart();
  }

  private readonly restart = (): void => {
    this.stop();
    if (document.visibilityState !== "visible" || this.motion?.matches) return;
    this.pulse();
  };

  private readonly pulse = (): void => {
    this.pulsing.set(true);
    this.timer = setTimeout(() => {
      this.pulsing.set(false);
      // Remove the animation entirely between pulses, rather than stretching an infinite CSS
      // animation across the quiet period. There is no frame work during this timeout.
      this.timer = setTimeout(this.pulse, PULSE_INTERVAL_MS - PULSE_DURATION_MS);
    }, PULSE_DURATION_MS);
  };

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pulsing.set(false);
  }

  ngOnDestroy(): void {
    this.stop();
    document.removeEventListener("visibilitychange", this.restart);
    this.motion?.removeEventListener("change", this.restart);
  }
}
