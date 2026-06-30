import { Injectable, signal } from "@angular/core";
import { STORAGE_KEYS } from "../browser/browser-contracts";

type BrowserAudioContext = AudioContext & {
  state: AudioContextState;
};

@Injectable({ providedIn: "root" })
export class MentionSoundService {
  readonly enabled = signal<boolean>(this.readEnabled());

  private audioContext: BrowserAudioContext | null = null;
  private gestureListenersAttached = false;
  private unlocked = false;

  constructor() {
    this.attachGestureUnlock();
  }

  setEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
    try {
      if (enabled) localStorage.removeItem(STORAGE_KEYS.MENTION_SOUND_ENABLED);
      else localStorage.setItem(STORAGE_KEYS.MENTION_SOUND_ENABLED, "0");
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    if (enabled) this.attachGestureUnlock();
  }

  playMention(): void {
    if (!this.enabled()) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      void this.playChime(ctx).catch(() => undefined);
    } catch {
      // Mention sound must never break realtime notification handling.
    }
  }

  private readEnabled(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEYS.MENTION_SOUND_ENABLED) !== "0";
    } catch {
      return true;
    }
  }

  private attachGestureUnlock(): void {
    if (this.gestureListenersAttached || typeof window === "undefined") return;
    this.gestureListenersAttached = true;
    const unlock = () => {
      this.unlockAudio();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      this.gestureListenersAttached = false;
    };
    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  private unlockAudio(): void {
    if (this.unlocked || !this.enabled()) return;
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      this.unlocked = true;
    } catch {
      // Browser audio support and autoplay policy differ; notification UI still works without sound.
    }
  }

  private getAudioContext(): BrowserAudioContext | null {
    if (this.audioContext) return this.audioContext;
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) return null;
    this.audioContext = new AudioContextCtor() as BrowserAudioContext;
    return this.audioContext;
  }

  private async playChime(ctx: BrowserAudioContext): Promise<void> {
    if (ctx.state === "suspended") await ctx.resume();
    const start = ctx.currentTime + 0.01;
    this.playTone(ctx, start, 880, 0.12, 0.09);
    this.playTone(ctx, start + 0.13, 1174.66, 0.18, 0.075);
  }

  private playTone(ctx: BrowserAudioContext, start: number, frequency: number, duration: number, volume: number): void {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.03);
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
