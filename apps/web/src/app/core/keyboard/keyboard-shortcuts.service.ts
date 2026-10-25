import { DestroyRef, Injectable, inject, signal } from "@angular/core";

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
  /** Run in this dialog while mounted; undefined means the page, with no dialog open. */
  dialog?: () => HTMLElement | undefined;
  /** Explicit app-wide entry points such as search/help may open above a dialog. */
  allowInDialog?: boolean;
}

interface Parsed {
  steps: { key: string; mod: boolean; shift: boolean; alt: boolean }[];
}

/** Longest time between the presses of a two-key sequence before the first press is forgotten. */
const SEQUENCE_TIMEOUT_MS = 1200;
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';

const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** True when a keydown originated in something the user types into, so bare-key shortcuts stand down. */
function isEditableTarget(target: EventTarget | null): boolean {
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

/**
 * Shifted forms of the punctuation keys on a US layout. Browsers usually report the shifted character
 * in `event.key` ("?"), but some platform/layout combinations report the unshifted key with
 * `shiftKey` set ("/" + Shift). Both must open the sheet, and neither must trigger a bare "/" binding.
 */
const SHIFTED_PUNCTUATION: Record<string, string> = {
  "/": "?", ".": ">", ",": "<", ";": ":", "'": '"', "[": "{", "]": "}", "\\": "|", "-": "_", "=": "+", "`": "~",
};
const UNSHIFTED_PUNCTUATION = new Map(Object.entries(SHIFTED_PUNCTUATION).map(([plain, shifted]) => [shifted, plain]));

function stepMatches(step: Parsed["steps"][number], event: KeyboardEvent): boolean {
  const mod = IS_APPLE ? event.metaKey : event.ctrlKey;
  const otherMod = IS_APPLE ? event.ctrlKey : event.metaKey;
  if (otherMod) return false;
  if (mod !== step.mod || event.altKey !== step.alt) return false;
  // Letters and named keys require exact modifiers: unavailable Shift+Mod+Z must never fall
  // through to Mod+Z. Literal symbols/digits may need Shift depending on the keyboard layout.
  if (step.shift && !event.shiftKey) return false;
  const layoutCharacter = step.key.length === 1 && step.key.toUpperCase() === step.key.toLowerCase();
  if (!step.shift && event.shiftKey && !layoutCharacter) return false;
  const key = event.key.toLowerCase();
  if (key === step.key) {
    // A bare "/" binding must not fire on Shift+/ where the layout reports "/" rather than "?":
    // the user asked for the shifted character, which is a different binding.
    return step.shift || !event.shiftKey || !(key in SHIFTED_PUNCTUATION) || step.key === SHIFTED_PUNCTUATION[key];
  }
  // Shift+/ reported as "/" still means "?".
  if (event.shiftKey && SHIFTED_PUNCTUATION[key] === step.key) return true;
  // And a layout that reports "?" for a `shift+/` binding should still match it.
  return step.shift && UNSHIFTED_PUNCTUATION.get(key) === step.key;
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
  private pending: (ShortcutRegistration & { parsed: Parsed })[] = [];
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private attached = false;

  /** Registry in sheet order: groups in first-registration order, entries in registration order. */
  readonly bindings = this.registrations.asReadonly();

  register(registration: ShortcutRegistration, destroyRef?: DestroyRef): () => void {
    const entry = { ...registration, parsed: parse(registration.keys) };
    this.registrations.update((list) => [...list, entry]);
    const unregister = () => {
      this.registrations.update((list) => list.filter((item) => item !== entry));
      this.pending = this.pending.filter((item) => item !== entry);
      if (!this.pending.length) this.clearPending();
    };
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
    document.addEventListener("focusin", this.onFocusChange);
  }

  private visibleDialogs(): Element[] {
    return [...document.querySelectorAll(DIALOG_SELECTOR)].filter((dialog) =>
      dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== "hidden",
    );
  }

  /** Shared by shortcut dispatch and the card's focus trap so neither can act behind another dialog. */
  isDialogActive(dialog: HTMLElement, target: EventTarget | null): boolean {
    // Use the nearest dialog, including nested dialogs, rather than guessing stacking from DOM
    // order. Search, notifications and CDK overlays can all sit above an already-mounted card.
    return target instanceof Element && target.closest(DIALOG_SELECTOR) === dialog;
  }

  private readonly onFocusChange = () => this.clearPending();

  private readonly onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) {
      this.clearPending();
      return;
    }
    if (event.repeat) return;
    // Modifier-only presses are never a step.
    if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
    const editable = isEditableTarget(event.target);
    const hasMod = event.metaKey || event.ctrlKey;
    const allowed = (registration: ShortcutRegistration) => {
      if (editable && !hasMod && !registration.allowInEditable) return false;
      if (!(registration.when?.() ?? true)) return false;
      if (registration.allowInDialog) return true;
      const dialog = registration.dialog?.();
      if (dialog) return this.isDialogActive(dialog, event.target);
      // Page bindings stand down even during the frame before a new dialog captures focus.
      return this.visibleDialogs().length === 0;
    };

    // Second press of a pending sequence.
    if (this.pending.length) {
      const candidates = this.pending;
      this.clearPending();
      for (const registration of candidates) {
        if (stepMatches(registration.parsed.steps[1], event) && allowed(registration)) {
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
      if (!allowed(registration)) continue;
      if (registration.parsed.steps.length > 1) {
        this.pending.push(registration);
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
    document.removeEventListener("focusin", this.onFocusChange);
    this.attached = false;
    this.clearPending();
  }

  readonly destroyRef = inject(DestroyRef);
}
