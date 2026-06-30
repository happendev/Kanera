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
});
