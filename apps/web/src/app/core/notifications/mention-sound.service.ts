import { computed, Injectable, signal } from "@angular/core";
import { STORAGE_KEYS } from "../browser/browser-contracts";

type BrowserAudioContext = AudioContext & {
  state: AudioContextState;
};

const CHIME_START_DELAY_SECONDS = 0.01;
type NotificationSound = "default" | "ripple" | "bloom" | "pebble" | "none";

// Original Kanera motifs: soft sine tones with rounded attacks and short tails.
// Offsets, frequencies, durations and gains keep every motif below half a second.
const MOTIFS = {
  default: [[0, 880, 0.12, 0.09], [0.13, 1174.66, 0.18, 0.075]],
  ripple: [[0, 659.25, 0.16, 0.065], [0.09, 783.99, 0.18, 0.05], [0.18, 987.77, 0.22, 0.04]],
  bloom: [[0, 523.25, 0.28, 0.055], [0.04, 659.25, 0.28, 0.035], [0.12, 783.99, 0.28, 0.03]],
  pebble: [[0, 698.46, 0.10, 0.065], [0.12, 523.25, 0.20, 0.055]],
} as const;

@Injectable({ providedIn: "root" })
export class MentionSoundService {
  readonly sound = signal<NotificationSound>(this.readSound());
  readonly enabled = computed(() => this.sound() !== "none");
  readonly options: ReadonlyArray<{ value: NotificationSound; label: string }> = [
    { value: "default", label: $localize`:Notification sound:Default` },
    { value: "ripple", label: $localize`:Notification sound:Ripple` },
    { value: "bloom", label: $localize`:Notification sound:Bloom` },
    { value: "pebble", label: $localize`:Notification sound:Pebble` },
    { value: "none", label: $localize`:Notification sound:None` },
  ];

  private audioContext: BrowserAudioContext | null = null;
  private gestureListenersAttached = false;
  private unlocked = false;
  private chimePlayingUntil = 0;

  constructor() {
    this.attachGestureUnlock();
  }

  setSound(value: string): void {
    if (!this.options.some((option) => option.value === value)) return;
    this.sound.set(value as NotificationSound);
    try {
      localStorage.setItem(STORAGE_KEYS.NOTIFICATION_SOUND, value);
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    if (this.enabled()) this.attachGestureUnlock();
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

  private readSound(): NotificationSound {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.NOTIFICATION_SOUND);
      if (saved === "none" || saved === "default" || saved === "ripple" || saved === "bloom" || saved === "pebble") return saved;
      // Preserve existing opt-outs when upgrading from the old on/off control.
      return localStorage.getItem(STORAGE_KEYS.MENTION_SOUND_ENABLED) === "0" ? "none" : "default";
    } catch {
      return "default";
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
    const sound = this.sound();
    if (sound === "none") return;
    // A burst can contain many notification events. One chime communicates the
    // burst without overlapping sounds or making the user hear a long queue.
    if (ctx.currentTime < this.chimePlayingUntil) return;
    const start = ctx.currentTime + CHIME_START_DELAY_SECONDS;
    const motif = MOTIFS[sound];
    this.chimePlayingUntil = start + Math.max(...motif.map(([offset, , duration]) => offset + duration + 0.03));
    for (const [offset, frequency, duration, volume] of motif) {
      this.playTone(ctx, start + offset, frequency, duration, volume);
    }
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
