export const COLOR_TOKENS = [
  "rose", "pink", "red", "orange", "amber", "yellow",
  "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "gray", "olive", "brown",
] as const;
export type ColorToken = typeof COLOR_TOKENS[number];

// Board backgrounds. The first row are two-stop gradients, the second are flat tones expressed as
// single-colour gradients so every consumer can keep reading `var(--gradient-<token>)`. Web renders
// each under a theme scrim (see --board-scrim in styles.scss), so the raw stops are chosen for how
// they read *through* that scrim in both themes, not on their own.
export const GRADIENT_TOKENS = [
  "sunrise", "ocean", "forest", "dusk", "midnight",
  "ember", "mint", "lavender", "peach", "graphite", "obsidian",
  "slate", "stone", "sand", "sage", "charcoal",
] as const;
export type GradientToken = typeof GRADIENT_TOKENS[number];
/** Tokens that render as a flat tone rather than a gradient; the picker groups them separately. */
export const SOLID_BACKGROUND_TOKENS = ["slate", "stone", "sand", "sage", "charcoal"] as const satisfies readonly GradientToken[];
