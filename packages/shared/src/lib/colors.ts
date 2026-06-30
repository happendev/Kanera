export const COLOR_TOKENS = [
  "rose", "pink", "red", "orange", "amber", "yellow",
  "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "gray", "olive", "brown",
] as const;
export type ColorToken = typeof COLOR_TOKENS[number];

export const GRADIENT_TOKENS = [
  "sunrise", "ocean", "forest", "dusk", "midnight",
  "ember", "mint", "lavender", "peach", "graphite",
] as const;
export type GradientToken = typeof GRADIENT_TOKENS[number];
