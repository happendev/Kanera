// Appearance vocabulary, shared by the Drizzle columns, the Zod DTOs and the web ThemeService so
// TypeScript, request validation and the database CHECK constraints cannot drift.
//
// Themes come in two families, each with a default and a neutral alternative: dark/carbon and
// light/paper. Adding one means adding it here, to the index.html pre-paint script, and to a token
// block in apps/web/src/styles.scss.
export const THEMES = ["light", "paper", "dark", "carbon"] as const;
export type Theme = (typeof THEMES)[number];

// The accent (primary) colour, chosen independently of the theme. "default" keeps whichever accent
// the theme itself ships. Blue and Green share one slot in the picker — which of the two is offered
// depends on the theme, see THEME_COOL_ACCENT in the web ThemeService.
export const ACCENTS = ["default", "blue", "green", "violet", "pink", "graphite"] as const;
export type Accent = (typeof ACCENTS)[number];
