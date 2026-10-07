/**
 * Re-tints a subtree's accent tokens with an identity colour (a board's or a workspace's).
 *
 * The identity colour is decorative; the *-accent token is its contrast-checked action tone (light
 * mode only — dark falls back to the identity colour and relies on --accent-ink). --accent-soft
 * resolves its var(--accent) where it is *declared*, so the :root definition would stay the default
 * teal here; it is rebound explicitly so engaged controls tint with the scope colour too.
 */
export function applyAccentScope(style: CSSStyleDeclaration, color: string | null | undefined): void {
  if (color) {
    const accent = `var(--color-${color}-accent, var(--color-${color}))`;
    style.setProperty("--accent", accent);
    style.setProperty("--accent-hover", `color-mix(in srgb, ${accent}, black 15%)`);
    style.setProperty("--accent-fg", "var(--accent-ink)");
    style.setProperty("--ring", `color-mix(in srgb, ${accent} 40%, transparent)`);
    style.setProperty("--accent-soft", `color-mix(in srgb, var(--color-${color}) 8%, transparent)`);
  } else {
    style.removeProperty("--accent");
    style.removeProperty("--accent-hover");
    style.removeProperty("--accent-fg");
    style.removeProperty("--ring");
    style.removeProperty("--accent-soft");
  }
}
