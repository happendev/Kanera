import { signal } from "@angular/core";
import type { Accent, Theme } from "@kanera/shared/appearance";
import DOMPurify from "dompurify";
import { marked, type Tokens } from "marked";
import type MermaidApi from "mermaid";

export interface MermaidTheme { name: Theme; accent: Accent }

let currentTheme: ReturnType<typeof signal<MermaidTheme>> | null = null;

/** Track the full appearance so cached SVGs follow both theme surfaces and the chosen accent. */
export function documentMermaidTheme(): MermaidTheme {
  if (!currentTheme) {
    const root = document.documentElement;
    const read = (): MermaidTheme => ({
      name: (root.dataset["theme"] as Theme | undefined)
        ?? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
      accent: (root.dataset["accent"] as Accent | undefined) ?? "default",
    });
    currentTheme = signal(read());
    new MutationObserver(() => currentTheme?.set(read())).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
  }
  return currentTheme();
}

/** Rendered SVG, or `null` when the source does not parse. */
type MermaidResult = string | null;

// Rendered diagrams are shared by every viewer, so toggling a description into edit mode and back
// (which recreates the viewer) does not redraw them. Bounded because each entry is a full SVG.
const CACHE_LIMIT = 40;
const cache = new Map<string, Promise<MermaidResult>>();
let queue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

/** Sources of the ```mermaid fences in a Markdown document, in document order (nested ones too). */
export function mermaidSources(markdown: string): string[] {
  if (!/mermaid/i.test(markdown)) return [];
  const sources: string[] = [];
  // The callback is synchronous; walkTokens only returns promises for async extensions.
  void marked.walkTokens(marked.lexer(markdown), (token) => {
    if (token.type !== "code") return;
    const code = token as Tokens.Code;
    if ((code.lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "mermaid") sources.push(code.text);
  });
  return sources;
}

export function mermaidCacheKey(source: string, theme: MermaidTheme): string {
  return `${theme.name}/${theme.accent}\n${source}`;
}

export function renderMermaid(source: string, theme: MermaidTheme): Promise<MermaidResult> {
  const key = mermaidCacheKey(source, theme);
  const cached = cache.get(key);
  if (cached) return cached;
  // Mermaid keeps global config and measures text in a scratch node, so overlapping renders can
  // pick up each other's theme or sizes. Run them one at a time.
  // Capture the tokens before queueing: the user may switch themes while another diagram draws.
  const styles = getComputedStyle(document.body);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const palette = {
    background: token("--surface"),
    fill: token("--surface-2"),
    border: token("--border-strong"),
    text: token("--text"),
    muted: token("--text-muted"),
    accent: token("--accent"),
    font: styles.fontFamily,
    fontSize: token("--text-md"),
    radius: token("--radius"),
  };
  const result = queue.then(() => renderNow(source, theme, palette));
  queue = result.catch(() => undefined);
  cache.set(key, result);
  // Only a parse failure is an answer; a failed chunk load must be retried.
  result.catch(() => {
    if (cache.get(key) === result) cache.delete(key);
  });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}

type Mermaid = typeof MermaidApi;

/**
 * Mermaid's own prebuilt ES modules, copied to /assets/vendor/mermaid by angular.json. Bundled through
 * the app build they would land in root-level chunks, which the service worker prefetches for offline
 * use on every install and update (several MB for a feature most people never use), and its optional
 * ELK layout chunk alone exceeds the per-script budget. Under /assets/ they are cached on first use.
 */
const MERMAID_MODULE = "assets/vendor/mermaid/mermaid.esm.min.mjs";
let mermaidModule: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= (import(/* @vite-ignore */ new URL(MERMAID_MODULE, document.baseURI).href) as Promise<{ default: Mermaid }>)
    .then((module) => module.default)
    .catch((error: unknown) => {
      // Offline before the first use: forget the failure so the next render tries again.
      mermaidModule = null;
      throw error;
    });
  return mermaidModule;
}

async function renderNow(source: string, theme: MermaidTheme, palette: {
  background: string; fill: string; border: string; text: string; muted: string; accent: string;
  font: string; fontSize: string; radius: string;
}): Promise<MermaidResult> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    // Strict escapes label HTML and disables click handlers; with SVG-only labels the output has
    // no foreignObject, so the SVG profile below keeps the whole diagram.
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    // Explicitly use the flat look; Mermaid's newer default adds shadows and gradients.
    look: "classic",
    theme: "base",
    fontFamily: palette.font,
    themeVariables: {
      darkMode: theme.name === "dark" || theme.name === "carbon",
      background: palette.background,
      fontFamily: palette.font,
      fontSize: palette.fontSize,
      primaryColor: palette.fill,
      primaryTextColor: palette.text,
      primaryBorderColor: palette.border,
      secondaryColor: palette.background,
      secondaryTextColor: palette.text,
      secondaryBorderColor: palette.border,
      tertiaryColor: palette.background,
      tertiaryTextColor: palette.text,
      tertiaryBorderColor: palette.border,
      lineColor: palette.muted,
      textColor: palette.text,
      edgeLabelBackground: palette.background,
      actorBkg: palette.fill,
      actorBorder: palette.border,
      actorTextColor: palette.text,
      actorLineColor: palette.border,
      signalColor: palette.muted,
      signalTextColor: palette.text,
      labelBoxBkgColor: palette.background,
      labelBoxBorderColor: palette.border,
      labelTextColor: palette.text,
      loopTextColor: palette.text,
      noteBkgColor: palette.fill,
      noteBorderColor: palette.border,
      noteTextColor: palette.text,
      activationBkgColor: palette.fill,
      activationBorderColor: palette.border,
    },
    themeCSS: `
      .node rect, .actor, .note {
        rx: ${palette.radius}; ry: ${palette.radius};
        fill: color-mix(in srgb, ${palette.fill} 90%, ${palette.accent});
        stroke: color-mix(in srgb, ${palette.border} 55%, ${palette.accent});
        stroke-width: 1.25px;
      }
      .node polygon {
        fill: color-mix(in srgb, ${palette.fill} 78%, ${palette.accent});
        stroke: ${palette.accent}; stroke-width: 1.5px;
      }
      .flowchart-link { stroke-width: 1.5px; }
      .edgeLabel { font-weight: 600; }
    `,
    flowchart: { wrappingWidth: 220, nodeSpacing: 32, rankSpacing: 40, padding: 16 },
  });
  try {
    const { svg } = await mermaid.render(`kanera-mermaid-${++renderCount}`, source);
    // The viewer bypasses Angular's sanitizer, so the SVG is sanitized here like the Markdown is.
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  } catch {
    return null;
  }
}
