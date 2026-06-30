import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { DomSanitizer } from "@angular/platform-browser";
import type { ResolveGitHubLinksResponse, ResolvedGitHubLink, ResolveInternalLinksResponse, ResolvedInternalLink } from "@kanera/shared/dto";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { ApiClient } from "../../core/api/api.client";
import { isSignedMediaUrlExpired, visibleSignedMediaUrl } from "../../core/media/signed-media-url";
import { attachmentIconClass } from "../../shared/attachment-icons";
import { avatarFallbackColorStyle } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "s", "code", "pre", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  "input",
  "a", "img", "hr", "span",
];

const ALLOWED_ATTR = ["href", "title", "src", "alt", "target", "rel", "class", "style", "data-user-id", "type", "checked", "disabled"];
const MENTION_RE = /@\[([^\]]+)\]\(kanera-user:([0-9a-fA-F-]{36})\)/g;
const BOARD_PATH_RE = /^\/b\/([0-9a-fA-F-]{36})(?:\/)?$/;
const CARD_PATH_RE = /^\/b\/([0-9a-fA-F-]{36})\/c\/([0-9a-fA-F-]{36})(?:\/)?$/;
const WORKSPACE_NOTES_PATH_RE = /^\/w\/([0-9a-fA-F-]{36})\/notes(?:\/)?$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+(?:\/(?:pull\/\d+|issues\/\d+|releases\/tag\/[^\s)]+|commit\/[0-9a-fA-F]{7,40}))?\/?(?:[?#][^\s)]*)?$/;
const COPY_RESET_MS = 1400;

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  lang?: string;
  ordered?: boolean;
  start?: number | "";
  task?: boolean;
  checked?: boolean;
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
};

function markdownToPlainText(markdown: string): string {
  return normalizePlainText(renderTokens(marked.lexer(markdown) as MarkdownToken[], 0));
}

function renderTokens(tokens: MarkdownToken[] | undefined, depth: number): string {
  return (tokens ?? [])
    .map((token) => renderToken(token, depth))
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function renderToken(token: MarkdownToken, depth: number): string {
  switch (token.type) {
    case "heading":
    case "paragraph":
      return renderInline(token.tokens, token.text);
    case "space":
      return "";
    case "list":
      return renderList(token, depth);
    case "blockquote":
      return renderBlockquote(token);
    case "code":
      return token.text ?? "";
    case "table":
      return renderTable(token);
    case "hr":
      return "----------";
    default:
      if (token.tokens?.length) return renderInline(token.tokens, token.text);
      return token.text ?? "";
  }
}

function renderList(token: MarkdownToken, depth: number): string {
  const start = typeof token.start === "number" ? token.start : 1;
  return (token.items ?? []).map((item, index) => {
    const marker = token.ordered ? `${start + index}.` : "-";
    const taskMarker = item.task ? `${item.checked ? "[x]" : "[ ]"} ` : "";
    const itemText = renderListItem(item, depth);
    const lines = itemText.split("\n");
    const firstIndent = "  ".repeat(depth);
    const childIndent = "  ".repeat(depth + 1);
    return [
      `${firstIndent}${marker} ${taskMarker}${lines[0] ?? ""}`.trimEnd(),
      ...lines.slice(1).map((line) => `${childIndent}${line}`.trimEnd()),
    ].join("\n");
  }).join("\n");
}

function renderListItem(item: MarkdownToken, depth: number): string {
  const parts = (item.tokens ?? []).map((child) => {
    if (child.type === "text") return renderInline(child.tokens, child.text);
    if (child.type === "list") return renderList(child, depth + 1);
    return renderToken(child, depth + 1);
  }).filter((part) => part.trim().length > 0);
  return parts.join("\n");
}

function renderBlockquote(token: MarkdownToken): string {
  return renderTokens(token.tokens, 0)
    .split("\n")
    .map((line) => line.trim() ? `> ${line}` : ">")
    .join("\n");
}

function renderTable(token: MarkdownToken): string {
  const rows = [
    ...(token.header ? [token.header] : []),
    ...(token.rows ?? []),
  ];
  const rendered = rows.map((row) => row.map((cell) => renderInline(cell.tokens, cell.text ?? "").replace(/\s+/g, " ").trim()));
  const widths = rendered.reduce<number[]>((acc, row) => {
    row.forEach((cell, index) => acc[index] = Math.max(acc[index] ?? 0, cell.length));
    return acc;
  }, []);
  return rendered.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd()).join("\n");
}

function renderInline(tokens: MarkdownToken[] | undefined, fallback = ""): string {
  if (!tokens?.length) return fallback;
  return tokens.map((token) => {
    switch (token.type) {
      case "text":
      case "strong":
      case "em":
      case "del":
        return renderInline(token.tokens, token.text ?? "");
      case "codespan":
        return token.text ?? "";
      case "br":
        return "\n";
      case "link": {
        const label = renderInline(token.tokens, token.text ?? "").trim();
        if (token.href?.startsWith("kanera-user:")) return label;
        return label || token.href || "";
      }
      case "image":
        return token.text ?? "";
      default:
        return token.text ?? renderInline(token.tokens);
    }
  }).join("");
}

function normalizePlainText(value: string): string {
  return value
    .replace(MENTION_RE, (_match, label: string) => `@${label}`)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

@Component({
  selector: "k-description-viewer",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    @if (value().trim().length === 0) {
      <span class="dv-empty">
        <i class="ti" [class]="emptyIconClass()"></i>
        {{ emptyLabel() }}
      </span>
    } @else {
      <div class="dv-shell" [class.dv-has-copy]="showCopy()">
        @if (showCopy()) {
          <button type="button" class="dv-copy-btn" (click)="copyText($event)" [attr.aria-label]="copied() ? 'Copied text' : 'Copy text'" [kTooltip]="copied() ? 'Copied' : 'Copy text'">
            <i class="ti" [class.ti-copy]="!copied()" [class.ti-copy-check]="copied()"></i>
          </button>
        }
        <div class="dv-body" [class.dv-compact]="compact()" [innerHTML]="html()" (click)="onClick($event)"></div>
      </div>
    }
  `,
  styles: `
    :host { display: block; }

    .dv-shell {
      position: relative;
    }

    .dv-has-copy {
      padding-right: 24px;
    }

    .dv-copy-btn {
      appearance: none;
      position: absolute;
      top: -2px;
      right: 0;
      z-index: 1;
      display: inline-grid;
      place-items: center;
      width: 20px;
      height: 20px;
      border: 0;
      border-radius: 0;
      background: transparent;
      background-color: transparent;
      color: var(--text-muted);
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s, color 0.12s;
    }

    .dv-copy-hover-scope:hover .dv-copy-btn,
    .dv-shell:hover .dv-copy-btn,
    .dv-shell:focus-within .dv-copy-btn {
      opacity: 0.72;
      pointer-events: auto;
    }

    button.dv-copy-btn:hover,
    button.dv-copy-btn:focus-visible {
      opacity: 1;
      color: var(--text);
      background: transparent;
      background-color: transparent;
    }

    .dv-copy-btn i {
      font-size: 14px;
    }

    .dv-empty {
      display: flex;
      align-items: center;
      gap: 7px;
      color: var(--text-muted);
      font-size: 13px;
      padding: 4px 0;
      i { font-size: 14px; opacity: 0.7; }
    }

    .dv-body {
      color: var(--text);
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
    }

    .dv-body :first-child { margin-top: 0; }
    .dv-body :last-child { margin-bottom: 0; }

    .dv-body p { margin: 0 0 10px; }
    .dv-compact p { margin: 0 0 4px; }
    .dv-body h1, .dv-body h2, .dv-body h3, .dv-body h4 {
      margin: 16px 0 8px;
      font-weight: 600;
      line-height: 1.3;
    }
    .dv-body h1 { font-size: 20px; }
    .dv-body h2 { font-size: 17px; }
    .dv-body h3 { font-size: 15px; }
    .dv-body h4 { font-size: 14px; }

    .dv-body ul, .dv-body ol { margin: 0 0 10px; padding-left: 22px; }
    .dv-body li { margin: 2px 0; }
    .dv-body li:has(> input[type="checkbox"]) {
      list-style: none;
      margin-left: -20px;
    }

    .dv-body input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0 7px 0 0;
      vertical-align: -2px;
      accent-color: var(--accent, #4f8cff);
      pointer-events: none;
    }

    .dv-body a { color: var(--accent, #4f8cff); text-decoration: underline; }

    .dv-body a.attachment-link-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      vertical-align: baseline;
      border: 1px solid color-mix(in srgb, var(--accent, #4f8cff) 20%, var(--border));
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent, #4f8cff) 7%, var(--surface));
      color: var(--text);
      text-decoration: none;
      font-weight: 600;
      font-size: 0.93em;
      line-height: 1.35;
      padding: 2px 8px 2px 6px;
      white-space: nowrap;
    }

    .dv-body a.attachment-link-chip:hover {
      border-color: color-mix(in srgb, var(--accent, #4f8cff) 38%, var(--border));
      background: color-mix(in srgb, var(--accent, #4f8cff) 11%, var(--surface));
    }

    .dv-body .attachment-link-chip i {
      flex: 0 0 auto;
      color: color-mix(in srgb, var(--accent, #4f8cff) 78%, var(--text));
      font-size: 1.05em;
    }

    .dv-body .attachment-link-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dv-body .mention-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      vertical-align: baseline;
      border: 1px solid color-mix(in srgb, var(--mention-avatar-bg) 55%, var(--border));
      border-radius: 999px;
      background: color-mix(in srgb, var(--mention-avatar-bg) 18%, var(--surface));
      color: color-mix(in srgb, var(--mention-avatar-fg) 76%, var(--text));
      font-weight: 600;
      font-size: 0.92em;
      line-height: 1.35;
      padding: 1px 7px 1px 3px;
      white-space: nowrap;
    }

    .dv-body .mention-chip-avatar {
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      overflow: hidden;
      border-radius: 999px;
      background: var(--mention-avatar-bg);
      color: var(--mention-avatar-fg);
      font-size: 8px;
      line-height: 1;
      font-weight: 700;
    }

    .dv-body a.internal-link-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      vertical-align: baseline;
      border: 1px solid color-mix(in srgb, var(--internal-link-color, var(--accent, #4f8cff)) 24%, var(--border));
      border-radius: 999px;
      background: color-mix(in srgb, var(--internal-link-color, var(--accent, #4f8cff)) 8%, var(--surface));
      color: var(--text);
      text-decoration: none;
      font-weight: 600;
      line-height: 1.35;
      padding: 1px 7px 1px 6px;
      white-space: nowrap;
    }

    .dv-body a.internal-link-chip:hover {
      border-color: color-mix(in srgb, var(--internal-link-color, var(--accent, #4f8cff)) 42%, var(--border));
      background: color-mix(in srgb, var(--internal-link-color, var(--accent, #4f8cff)) 12%, var(--surface));
    }

    .dv-body .internal-link-chip i {
      flex: 0 0 auto;
      color: color-mix(in srgb, var(--internal-link-color, var(--accent, #4f8cff)) 75%, var(--text));
      font-size: 1em;
    }

    .dv-body a.github-link-card {
      display: block;
      max-width: min(100%, 420px);
      margin: 8px 0 12px;
      border: 1px solid color-mix(in srgb, var(--border-strong) 88%, var(--text-muted));
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 1px 2px color-mix(in srgb, #000 7%, transparent);
      color: var(--text);
      text-decoration: none;
      overflow: hidden;
    }

    .dv-body a.github-link-card:hover {
      border-color: color-mix(in srgb, var(--text-muted) 44%, var(--border-strong));
      box-shadow: 0 2px 8px color-mix(in srgb, #000 9%, transparent);
    }

    .dv-body .github-link-card-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 10px 12px 8px;
    }

    .dv-body .github-link-card-title {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      max-width: 100%;
      font-weight: 700;
      font-size: 13px;
      line-height: 1.35;
    }

    .dv-body .github-link-brand-icon {
      flex: 0 0 auto;
      color: var(--text);
      font-size: 14px;
    }

    .dv-body .github-link-card-title-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dv-body .github-link-card-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      margin-top: 2px;
      color: var(--text-muted);
      font-size: 12px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dv-body .github-link-card-meta i {
      flex: 0 0 auto;
      font-size: 13px;
    }

    .dv-body .github-link-card-actions {
      display: flex;
      align-items: flex-start;
      gap: 4px;
    }

    .dv-body .github-link-card-action {
      display: inline-grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text-muted);
      background: color-mix(in srgb, var(--surface-2) 70%, transparent);
      font-size: 14px;
    }

    .dv-body .github-link-card-stats {
      display: grid;
      grid-template-columns: 1fr auto;
      margin: 0 12px 12px;
      border: 1px solid var(--border);
      border-radius: 7px;
      overflow: hidden;
      font-size: 12px;
      line-height: 1.35;
    }

    .dv-body .github-link-card-stat-label,
    .dv-body .github-link-card-stat-value {
      padding: 7px 8px;
      border-top: 1px solid var(--border);
    }

    .dv-body .github-link-card-stat-label:nth-child(1),
    .dv-body .github-link-card-stat-value:nth-child(2) {
      border-top: none;
    }

    .dv-body .github-link-card-stat-label {
      color: var(--text-muted);
      border-right: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface-2) 42%, transparent);
    }

    .dv-body .github-link-card-stat-value {
      min-width: 112px;
      color: var(--text);
      background: var(--surface);
    }

    .dv-body .github-link-additions { color: #047857; }
    .dv-body .github-link-deletions { color: #dc2626; }

    .dv-body .internal-link-title,
    .dv-body .internal-link-hint {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dv-body .internal-link-hint {
      color: var(--text-muted);
      font-weight: 500;
      font-size: 0.88em;
    }

    .dv-body code {
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 12.5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--text);
    }

    .dv-body pre {
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      overflow-x: auto;
      margin: 0 0 10px;
      color: var(--text);
    }

    .dv-body pre code {
      background: transparent;
      border: none;
      padding: 0;
      font-size: 12.5px;
      color: inherit;
    }

    .dv-body blockquote {
      border-left: 3px solid var(--border-strong);
      margin: 0 0 10px;
      padding: 2px 12px;
      color: var(--text-muted);
    }

    .dv-body table {
      display: block;
      max-width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
      margin: 0 0 12px;
      font-size: 13px;
      line-height: 1.45;
    }

    .dv-body th,
    .dv-body td {
      border: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }

    .dv-body th {
      background: var(--surface-2);
      font-weight: 600;
    }

    .dv-body img {
      max-width: 100%;
      max-height: 420px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      cursor: zoom-in;
      display: block;
      margin: 8px 0;
    }

    .dv-body .mention-chip-avatar img {
      width: 100%;
      height: 100%;
      max-width: none;
      max-height: none;
      display: block;
      object-fit: cover;
      margin: 0;
      border: 0;
      border-radius: inherit;
      cursor: default;
    }

    .dv-body hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 14px 0;
    }
  `,
})
export class DescriptionViewerComponent {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly api = inject(ApiClient, { optional: true });

  readonly value = input.required<string>();
  readonly compact = input<boolean>(false);
  readonly workspaceId = input<string | null>(null);
  readonly mentionMembers = input<WireBoardMemberUser[]>([]);
  readonly emptyLabel = input<string>("Add a description…");
  readonly emptyIcon = input<string>("pencil");
  readonly handleImageClicks = input<boolean>(true);
  readonly showCopy = input<boolean>(false);
  readonly imageClick = output<string>();

  readonly emptyIconClass = computed(() => `ti ti-${this.emptyIcon()}`);
  readonly copied = signal(false);
  private readonly resolvedLinks = signal<Record<string, ResolvedInternalLink>>({});
  private readonly resolvedGitHubLinks = signal<Record<string, ResolvedGitHubLink>>({});
  private copyResetTimer: number | null = null;

  private readonly cleanHtml = computed(() => {
    const withBareLinks = this.linkBareGitHubUrls(this.linkBareInternalUrls(this.value()));
    const withMentions = withBareLinks.replace(MENTION_RE, (_match, label: string, userId: string) =>
      this.renderMentionChip(label, userId),
    );
    const raw = marked.parse(withMentions, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
    });
  });

  readonly html = computed(() => {
    const decoratedInternal = this.decorateInternalLinks(this.cleanHtml(), this.resolvedLinks());
    const decoratedGitHub = this.decorateGitHubLinks(decoratedInternal, this.resolvedGitHubLinks());
    const decorated = this.decorateAttachmentLinks(decoratedGitHub);
    const withVisibleMedia = this.suppressExpiredMediaImages(decorated);
    return this.sanitizer.bypassSecurityTrustHtml(withVisibleMedia);
  });

  constructor() {
    effect(() => {
      const resolved = this.resolvedLinks();
      const urls = this.extractResolvableUrls(this.cleanHtml()).filter((url) => !resolved[url]);
      if (!urls.length || !this.api) return;

      const unique = [...new Set(urls)].slice(0, 50);
      void this.api.post<ResolveInternalLinksResponse>("/internal-links/resolve", { urls: unique })
        .then((response) => {
          if (!response.links || Object.keys(response.links).length === 0) return;
          this.resolvedLinks.update((links) => ({ ...links, ...response.links }));
        })
        .catch(() => undefined);
    });

    effect(() => {
      const resolved = this.resolvedGitHubLinks();
      const urls = this.extractGitHubUrls(this.cleanHtml()).filter((url) => !resolved[url]);
      if (!urls.length || !this.api) return;

      const unique = [...new Set(urls)].slice(0, 50);
      void this.api.post<ResolveGitHubLinksResponse>("/github-links/resolve", {
        urls: unique,
        workspaceId: this.workspaceId() ?? undefined,
      })
        .then((response) => {
          if (!response.links || Object.keys(response.links).length === 0) return;
          this.resolvedGitHubLinks.update((links) => ({ ...links, ...response.links }));
        })
        .catch(() => undefined);
    });
  }

  onClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "IMG") {
      if (!this.handleImageClicks()) return;
      const src = (target as HTMLImageElement).src;
      if (src) {
        event.stopPropagation();
        this.imageClick.emit(src);
      }
      return;
    }

    const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
    if (!anchor || !this.isKaneraMediaHref(anchor.href)) return;
    const fileName = this.attachmentFileNameForLink(anchor);
    if (!fileName) return;

    event.preventDefault();
    event.stopPropagation();
    void this.downloadMediaLink(anchor.href, fileName);
  }

  async copyText(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    await navigator.clipboard?.writeText(markdownToPlainText(this.value())).catch(() => undefined);
    this.copied.set(true);
    if (this.copyResetTimer !== null) window.clearTimeout(this.copyResetTimer);
    this.copyResetTimer = window.setTimeout(() => {
      this.copied.set(false);
      this.copyResetTimer = null;
    }, COPY_RESET_MS);
  }

  private async downloadMediaLink(url: string, fileName: string) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Attachment download failed with status ${response.status}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        this.triggerDownload(objectUrl, fileName);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      return;
    } catch {
      this.triggerDownload(url, fileName);
    }
  }

  private renderMentionChip(label: string, userId: string): string {
    const member = this.mentionMembers().find((m) => m.userId === userId);
    const displayName = member?.displayName || label;
    const style = avatarFallbackColorStyle(userId, displayName);
    // Drop an expired signed avatar URL (stale cached member list) so the chip
    // shows the initial fallback rather than a broken 404 image.
    const avatarUrl = visibleSignedMediaUrl(member?.avatarUrl);
    const avatar = avatarUrl
      ? `<span class="mention-chip-avatar"><img src="${this.escapeAttr(avatarUrl)}" alt="" /></span>`
      : `<span class="mention-chip-avatar" aria-hidden="true">${this.escapeHtml(this.initial(displayName))}</span>`;
    return `<span class="mention-chip" data-user-id="${this.escapeAttr(userId)}" style="${this.escapeAttr(style)}">${avatar}<span>@${this.escapeHtml(label)}</span></span>`;
  }

  private initial(name: string): string {
    return (name || "?").charAt(0).toUpperCase();
  }

  private extractResolvableUrls(html: string): string[] {
    const doc = this.parseHtml(html);
    if (!doc) return [];
    return Array.from(doc.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => this.isKaneraInternalHref(href));
  }

  private extractGitHubUrls(html: string): string[] {
    const doc = this.parseHtml(html);
    if (!doc) return [];
    return Array.from(doc.querySelectorAll("a[href]"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => this.isSupportedGitHubHref(href));
  }

  private linkBareInternalUrls(markdown: string): string {
    const uuid = "[0-9a-fA-F-]{36}";
    const suffix = "(?:[?#][^\\s)]*)?";
    const path = `(?:/b/${uuid}(?:/c/${uuid})?|/w/${uuid}/notes)${suffix}`;
    const absolute = `https?:\\/\\/[^\\s)]+?${path}`;
    const relative = path;
    const re = new RegExp(`(^|\\s)(${absolute}|${relative})(?=$|[\\s.,!?])`, "g");
    return markdown.replace(re, (match: string, prefix: string, url: string) => {
      if (!this.isKaneraInternalHref(url)) return match;
      return `${prefix}[${url}](${url})`;
    });
  }

  private linkBareGitHubUrls(markdown: string): string {
    const ownerRepo = "github\\.com\\/[^\\/\\s)]+\\/[^\\/\\s).,!?]+";
    const releaseTag = "releases\\/tag\\/[^\\s),!?]*[^\\s),.!?]";
    const suffix = `(?:\\/(?:pull\\/\\d+|issues\\/\\d+|${releaseTag}|commit\\/[0-9a-fA-F]{7,40}))?`;
    const query = "(?:[?#][^\\s)]*)?";
    const re = new RegExp(`(^|\\s)(https:\\/\\/${ownerRepo}${suffix}\\/?${query})(?=$|[\\s.,!?])`, "g");
    return markdown.replace(re, (match: string, prefix: string, url: string) => {
      if (!this.isSupportedGitHubHref(url)) return match;
      return `${prefix}[${url}](${url})`;
    });
  }

  private decorateInternalLinks(html: string, resolved: Record<string, ResolvedInternalLink>): string {
    const doc = this.parseHtml(html);
    if (!doc) return html;

    for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const href = anchor.getAttribute("href") ?? "";
      if (!this.isKaneraInternalHref(href)) continue;
      const link = resolved[href];
      if (!link) continue;

      anchor.classList.add("internal-link-chip", link.kind === "card" ? "is-card" : link.kind === "note" ? "is-note" : "is-board");
      anchor.setAttribute("href", link.href);
      anchor.setAttribute("title", this.internalLinkTitle(link));
      const iconSlug = link.kind === "card" ? (link.boardIcon || "cardboards") : (link.icon || (link.kind === "note" ? "file-text" : "layout-board"));
      const iconColor = link.kind === "card" ? link.boardIconColor : link.kind === "board" ? link.iconColor : link.color;
      if (iconColor) anchor.setAttribute("style", `--internal-link-color: var(--color-${this.escapeAttr(iconColor)})`);
      const hint = this.internalLinkHint(link);
      anchor.innerHTML = `
        <i class="ti ti-${this.escapeAttr(iconSlug)}" aria-hidden="true"></i>
        <span class="internal-link-title">${this.escapeHtml(link.title)}</span>
        <span class="internal-link-hint">${this.escapeHtml(hint)}</span>
      `;
    }

    return doc.body.innerHTML;
  }

  private decorateGitHubLinks(html: string, resolved: Record<string, ResolvedGitHubLink>): string {
    const doc = this.parseHtml(html);
    if (!doc) return html;

    for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const href = anchor.getAttribute("href") ?? "";
      if (!this.isSupportedGitHubHref(href)) continue;
      const link = resolved[href];
      if (!link) continue;

      anchor.classList.add("github-link-card", `is-${link.kind}`);
      anchor.setAttribute("href", link.href);
      anchor.setAttribute("title", this.githubTitle(link));
      const iconSlug = link.kind === "pull" ? "git-pull-request" : link.kind === "issue" ? "circle-dot" : link.kind === "release" ? "tag" : link.kind === "commit" ? "git-commit" : "brand-github";
      anchor.innerHTML = `
        <span class="github-link-card-header">
          <span>
            <span class="github-link-card-title">
              <i class="ti ti-brand-github github-link-brand-icon"></i>
              <span class="github-link-card-title-text">${this.escapeHtml(this.githubLabel(link))}</span>
            </span>
            <span class="github-link-card-meta">
              <i class="ti ti-${this.escapeAttr(iconSlug)}"></i>
              <span>${this.escapeHtml(this.githubHint(link))}</span>
            </span>
          </span>
          <span class="github-link-card-actions">
            <span class="github-link-card-action"><i class="ti ti-link"></i></span>
            <span class="github-link-card-action"><i class="ti ti-external-link"></i></span>
          </span>
        </span>
        ${this.githubStatsHtml(link)}
      `;
    }

    return doc.body.innerHTML;
  }

  private decorateAttachmentLinks(html: string): string {
    const doc = this.parseHtml(html);
    if (!doc) return html;

    for (const anchor of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const href = anchor.getAttribute("href") ?? "";
      if (!this.isKaneraMediaHref(href)) continue;
      const fileName = this.attachmentFileNameForLink(anchor);
      if (!fileName) continue;

      anchor.classList.add("attachment-link-chip");
      anchor.setAttribute("title", fileName);
      anchor.innerHTML = `
        <i class="ti ${this.escapeAttr(attachmentIconClass(this.mediaMimeHint(href), fileName))}"></i>
        <span class="attachment-link-title">${this.escapeHtml(fileName)}</span>
      `;
    }

    return doc.body.innerHTML;
  }

  // Strip embedded <img> whose signed-media src has already expired (e.g. a
  // description/comment body restored from an offline snapshot). Rendering it
  // only produces a 404; the live fetch re-supplies markup with re-signed URLs,
  // and offline the URL could not be served anyway. Non-media images are left
  // untouched.
  private suppressExpiredMediaImages(html: string): string {
    if (!html.includes("/api/media/")) return html;
    const doc = this.parseHtml(html);
    if (!doc) return html;
    let changed = false;
    for (const img of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) {
      if (isSignedMediaUrlExpired(img.getAttribute("src"))) {
        img.remove();
        changed = true;
      }
    }
    return changed ? doc.body.innerHTML : html;
  }

  private parseHtml(html: string): Document | null {
    if (typeof DOMParser === "undefined") return null;
    return new DOMParser().parseFromString(html, "text/html");
  }

  private isKaneraInternalHref(href: string): boolean {
    if (!href) return false;
    try {
      const url = new URL(href, window.location.origin);
      if (!this.isAllowedInternalOrigin(url.origin)) return false;
      if (CARD_PATH_RE.test(url.pathname)) return true;
      if (WORKSPACE_NOTES_PATH_RE.test(url.pathname)) {
        const noteId = url.searchParams.get("noteId");
        return Boolean(noteId && UUID_RE.test(noteId));
      }
      if (!BOARD_PATH_RE.test(url.pathname)) return false;
      const cardId = url.searchParams.get("cardId");
      const noteId = url.searchParams.get("noteId");
      if (cardId) return UUID_RE.test(cardId);
      if (noteId) return url.searchParams.get("view") === "notes" && UUID_RE.test(noteId);
      return true;
    } catch {
      return false;
    }
  }

  private isAllowedInternalOrigin(origin: string): boolean {
    if (origin === window.location.origin) return true;
    return this.isLoopbackOrigin(window.location.origin) && this.isLoopbackOrigin(origin);
  }

  private isLoopbackOrigin(origin: string): boolean {
    try {
      const hostname = new URL(origin).hostname;
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
    }
  }

  private isSupportedGitHubHref(href: string): boolean {
    return GITHUB_URL_RE.test(href);
  }

  private isKaneraMediaHref(href: string): boolean {
    try {
      return new URL(href, window.location.origin).pathname.startsWith("/api/media/");
    } catch {
      return false;
    }
  }

  private attachmentFileNameForLink(anchor: HTMLAnchorElement): string | null {
    const label = anchor.textContent?.trim() ?? "";
    if (!label || label.includes("/") || label.includes("\\") || /^https?:\/\//i.test(label)) return null;
    return label;
  }

  private mediaMimeHint(href: string): string {
    try {
      const url = new URL(href, window.location.origin);
      const name = url.searchParams.get("fn") || url.pathname.split("/").pop() || "";
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (ext === "pdf") return "application/pdf";
      if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return `image/${ext === "jpg" ? "jpeg" : ext}`;
      if (["mp3", "wav", "ogg", "m4a"].includes(ext)) return "audio/*";
      if (["mp4", "mov", "webm"].includes(ext)) return "video/*";
      if (["zip", "gz", "rar", "7z", "tar", "tgz"].includes(ext)) return "application/zip";
      if (["csv", "xls", "xlsx", "ods"].includes(ext)) return "application/vnd.ms-excel";
      if (["ppt", "pptx", "odp", "key"].includes(ext)) return "application/vnd.ms-powerpoint";
      if (["doc", "docx", "odt", "rtf"].includes(ext)) return "application/msword";
      if (["txt", "md", "markdown"].includes(ext)) return "text/plain";
      return "";
    } catch {
      return "";
    }
  }

  private triggerDownload(url: string, fileName: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  }

  private githubLabel(link: ResolvedGitHubLink): string {
    if (link.kind === "pull") return `PR #${link.number}: ${link.title}`;
    if (link.kind === "issue") return `Issue #${link.number}: ${link.title}`;
    if (link.kind === "release") return `${link.tagName}: ${link.title}`;
    if (link.kind === "commit") return `${link.shortSha}: ${link.title}`;
    return link.title;
  }

  private internalLinkTitle(link: ResolvedInternalLink): string {
    if (link.kind === "card") return `${link.title} (${link.boardName} - ${link.listName})`;
    if (link.kind === "note") return link.boardName ? `${link.title} (${link.boardName})` : link.title;
    return link.title;
  }

  private internalLinkHint(link: ResolvedInternalLink): string {
    if (link.kind === "card") return `${link.boardName} - ${link.listName}`;
    if (link.kind === "note") return link.boardName ?? (link.scope === "personal" ? "Private note" : "Team note");
    return "Board";
  }

  private githubHint(link: ResolvedGitHubLink): string {
    if (link.kind === "pull") return `${link.fullName} · ${link.state}`;
    if (link.kind === "issue") return `${link.fullName} · ${link.state}`;
    if (link.kind === "release") return `${link.fullName} · ${link.state}`;
    if (link.kind === "commit") return link.fullName;
    return link.description || (link.private ? "Private repository" : "Repository");
  }

  private githubTitle(link: ResolvedGitHubLink): string {
    if (link.kind === "repo") return link.description ? `${link.title} - ${link.description}` : link.title;
    if (link.kind === "pull") return `${link.fullName} PR #${link.number}: ${link.title}`;
    if (link.kind === "issue") return `${link.fullName} Issue #${link.number}: ${link.title}`;
    if (link.kind === "release") return `${link.fullName} ${link.tagName}: ${link.title}`;
    return `${link.fullName}@${link.shortSha}: ${link.title}`;
  }

  private githubStatsHtml(link: ResolvedGitHubLink): string {
    if (link.kind === "repo" || link.kind === "issue" || link.kind === "release") return "";
    const changedFiles = link.changedFiles;
    const additions = link.additions;
    const deletions = link.deletions;
    if (changedFiles === null && additions === null && deletions === null) return "";
    return `
      <span class="github-link-card-stats">
        <span class="github-link-card-stat-label">Changed files</span>
        <span class="github-link-card-stat-value">${changedFiles === null ? "-" : this.escapeHtml(String(changedFiles))}</span>
        <span class="github-link-card-stat-label">Line changes</span>
        <span class="github-link-card-stat-value">
          <span class="github-link-additions">+${additions === null ? "0" : this.escapeHtml(String(additions))}</span>
          <span class="github-link-deletions">-${deletions === null ? "0" : this.escapeHtml(String(deletions))}</span>
        </span>
      </span>
    `;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  private escapeAttr(value: string): string {
    return this.escapeHtml(value).replace(/"/g, "&quot;");
  }
}
