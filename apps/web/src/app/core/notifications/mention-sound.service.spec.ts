import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../browser/browser-contracts";
import { MentionSoundService } from "./mention-sound.service";

describe("MentionSoundService", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  });

  it("defaults mention sounds on and persists disabled state", () => {
    const service = TestBed.inject(MentionSoundService);

    expect(service.enabled()).toBe(true);

    service.setEnabled(false);
    expect(service.enabled()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.MENTION_SOUND_ENABLED)).toBe("0");

    service.setEnabled(true);
    expect(service.enabled()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.MENTION_SOUND_ENABLED)).toBeNull();
  });

  it("reads a disabled preference from storage", () => {
    localStorage.setItem(STORAGE_KEYS.MENTION_SOUND_ENABLED, "0");

    const service = TestBed.inject(MentionSoundService);

    expect(service.enabled()).toBe(false);
  });

  it("swallows Web Audio playback errors", () => {
    class FailingAudioContext {
      readonly state: AudioContextState = "running";
      readonly currentTime = 0;
      resume = vi.fn(() => Promise.resolve());
      createOscillator = vi.fn(() => {
        throw new Error("audio failed");
      });
      createGain = vi.fn();
      readonly destination = {};
    }
    (window as unknown as { AudioContext: typeof FailingAudioContext }).AudioContext = FailingAudioContext;
    const service = TestBed.inject(MentionSoundService);

    expect(() => service.playMention()).not.toThrow();
  });

  it("coalesces a burst into one chime and allows a later chime", async () => {
    const starts: number[] = [];
    const stops: number[] = [];
    let currentTime = 10;

    class AudioContextMock {
      readonly state: AudioContextState = "running";
      get currentTime(): number {
        return currentTime;
      }
      readonly destination = {};
      resume = vi.fn(() => Promise.resolve());
      createOscillator = vi.fn(() => ({
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn((at: number) => starts.push(at)),
        stop: vi.fn((at: number) => stops.push(at)),
      }));
      createGain = vi.fn(() => ({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }));
    }
    (window as unknown as { AudioContext: typeof AudioContextMock }).AudioContext = AudioContextMock;
    const service = TestBed.inject(MentionSoundService);

    service.playMention();
    service.playMention();
    service.playMention();
    await Promise.resolve();

    [10.01, 10.14].forEach((expected, index) => {
      expect(starts[index]).toBeCloseTo(expected);
    });
    [10.16, 10.35].forEach((expected, index) => {
      expect(stops[index]).toBeCloseTo(expected);
    });
    expect(starts).toHaveLength(2);

    currentTime = 10.35;
    service.playMention();
    await Promise.resolve();

    expect(starts).toHaveLength(4);
    expect(starts[2]).toBeCloseTo(10.36);
    expect(starts[2]).toBeGreaterThanOrEqual(stops[1]);
  });
});
