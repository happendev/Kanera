import { DestroyRef, Injectable, computed, inject, signal } from "@angular/core";

/**
 * A key description. Chords join modifiers and a key with "+" (`mod+k`, `mod+shift+.`); sequences
 * separate successive presses with a space (`g h`). `mod` means ⌘ on Apple platforms and Ctrl
 * elsewhere. Keys are compared case-insensitively against KeyboardEvent.key, so `?` matches the
 * shifted press on any layout without naming Shift.
 */
export type ShortcutKeys = string;

export interface ShortcutRegistration {
  keys: ShortcutKeys;
  /** Shown in the shortcuts sheet. Imperative, short: "Open a new card". */
  label: string;
  /** Sheet section. Pages register under their own name so the sheet reflects what is on screen. */
  group: string;
  /** Skipped (and the key falls through) while this returns false. */
  when?: () => boolean;
  run: () => void;
  /**
   * Bare keys normally stand down inside inputs so typing is never hijacked. A registration can opt
   * in for keys that only make sense while typing (none today; kept for completeness).
   */
  allowInEditable?: boolean;
}

interface Parsed {
  steps: { key: string; mod: boolean; shift: boolean; alt: boolean }[];
}

/** Longest time between the presses of a two-key sequence before the first press is forgotten. */
const SEQUENCE_TIMEOUT_MS = 1200;

export const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** True when a keydown originated in something the user types into, so bare-key shortcuts stand down. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function parse(keys: ShortcutKeys): Parsed {
  return {
    steps: keys.trim().split(/\s+/).map((step) => {
      const parts = step.split("+");
      const key = parts.pop()!.toLowerCase();
      const mods = new Set(parts.map((p) => p.toLowerCase()));
      return { key, mod: mods.has("mod"), shift: mods.has("shift"), alt: mods.has("alt") };
    }),
  };
}

function stepMatches(step: Parsed["steps"][number], event: KeyboardEvent): boolean {
  const mod = IS_APPLE ? event.metaKey : event.ctrlKey;
  const otherMod = IS_APPLE ? event.ctrlKey : event.metaKey;
  if (otherMod) return false;
  if (mod !== step.mod || event.altKey !== step.alt) return false;
  // Shift is only enforced when the binding names it: `?` already implies Shift on most layouts, and
  // demanding it explicitly would break layouts where it does not.
  if (step.shift && !event.shiftKey) return false;
  return event.key.toLowerCase() === step.key;
}

/** Human labels for the sheet and tooltips: `mod+shift+.` → ["⌘", "⇧", "."] or ["Ctrl", "Shift", "."]. */
export function formatShortcut(keys: ShortcutKeys): string[][] {
  return keys.trim().split(/\s+/).map((step) =>
    step.split("+").map((part) => {
      switch (part.toLowerCase()) {
        case "mod": return IS_APPLE ? "⌘" : "Ctrl";
        case "shift": return IS_APPLE ? "⇧" : "Shift";
        case "alt": return IS_APPLE ? "⌥" : "Alt";
        case "escape": return "Esc";
        case "enter": return "Enter";
        case "arrowup": return "↑";
        case "arrowdown": return "↓";
        case "arrowleft": return "←";
        case "arrowright": return "→";
        default: return part.length === 1 ? part.toUpperCase() : part;
      }
    }),
  );
}

/**
 * One document-level keyboard dispatcher for the whole app.
 *
 * Components register bindings for as long as they live; the most recently registered binding for a
 * key wins, which is what lets an open card override the board underneath it without either knowing
 * about the other. The shortcuts sheet renders straight from this registry, so it can never list a
 * shortcut that does not exist or omit one that does.
 */
@Injectable({ providedIn: "root" })
export class KeyboardShortcutsService {
  private readonly registrations = signal<readonly (ShortcutRegistration & { parsed: Parsed })[]>([]);
  private pending: { registration: ShortcutRegistration & { parsed: Parsed }; at: number }[] = [];
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private attached = false;

  /** Registry in sheet order: groups in first-registration order, entries in registration order. */
  readonly bindings = computed(() => this.registrations());

  register(registration: ShortcutRegistration, destroyRef?: DestroyRef): () => void {
    const entry = { ...registration, parsed: parse(registration.keys) };
    this.registrations.update((list) => [...list, entry]);
    const unregister = () => this.registrations.update((list) => list.filter((item) => item !== entry));
    destroyRef?.onDestroy(unregister);
    return unregister;
  }

  /** Registers several bindings under one group; returns a single unregister. */
  registerAll(group: string, items: Omit<ShortcutRegistration, "group">[], destroyRef?: DestroyRef): () => void {
    const offs = items.map((item) => this.register({ ...item, group }, destroyRef));
    return () => offs.forEach((off) => off());
  }

  /** Called once by the shell. Idempotent. */
  attach(): void {
    if (this.attached || typeof document === "undefined") return;
    this.attached = true;
    document.addEventListener("keydown", this.onKeydown);
  }

  private readonly onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    // Modifier-only presses are never a step.
    if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
    const editable = isEditableTarget(event.target);
    const hasMod = event.metaKey || event.ctrlKey;

    // Second press of a pending sequence.
    if (this.pending.length) {
      const candidates = this.pending;
      this.clearPending();
      for (const { registration } of candidates) {
        if (stepMatches(registration.parsed.steps[1], event) && (registration.when?.() ?? true)) {
          event.preventDefault();
          registration.run();
          return;
        }
      }
      // A miss falls through to first-step matching below, so `g` then `c` still opens a card.
    }

    // Newest registration wins.
    const list = this.registrations();
    for (let i = list.length - 1; i >= 0; i--) {
      const registration = list[i];
      const first = registration.parsed.steps[0];
      if (!stepMatches(first, event)) continue;
      // Bare keys stand down while typing; chords with a modifier are safe anywhere.
      if (editable && !hasMod && !registration.allowInEditable) continue;
      if (!(registration.when?.() ?? true)) continue;
      if (registration.parsed.steps.length > 1) {
        this.pending.push({ registration, at: Date.now() });
        continue;
      }
      event.preventDefault();
      registration.run();
      return;
    }
    if (this.pending.length) {
      event.preventDefault();
      this.pendingTimer = setTimeout(() => this.clearPending(), SEQUENCE_TIMEOUT_MS);
    }
  };

  private clearPending(): void {
    this.pending = [];
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }

  /** Test seam and hot-reload hygiene. */
  detach(): void {
    if (!this.attached) return;
    document.removeEventListener("keydown", this.onKeydown);
    this.attached = false;
    this.clearPending();
  }

  readonly destroyRef = inject(DestroyRef);
}
