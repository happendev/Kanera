import type {
  AfterViewInit,
  ElementRef,
  OnDestroy
} from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  ViewEncapsulation,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { Editor, Extension } from "@tiptap/core";
import Emoji, { shortcodeToEmoji, emojis as tiptapEmojis, type EmojiItem } from "@tiptap/extension-emoji";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { DescriptionEditorToolbarComponent } from "./description-editor-toolbar.component";
import { DESCRIPTION_EDITOR_ACCEPT, DescriptionEditorUploader, type AttachmentTarget } from "./description-editor-uploader.service";

export type EditorSaveEvent = { markdown: string; attachmentIds: string[] };

const POPULAR_EMOJI_SHORTCODES = [
  "smile",
  "thumbsup",
  "heart",
  "tada",
  "eyes",
  "rocket",
  "white_check_mark",
  "warning",
  "fire",
  "thinking",
  "pray",
  "muscle",
];
const EMOJI_CATEGORIES = [
  { key: "common", label: "Common", icon: "⭐" },
  { key: "people", label: "Smileys & People", icon: "😀", groups: ["", "people & body"] },
  { key: "nature", label: "Animals & Nature", icon: "🐶", groups: ["animals & nature"] },
  { key: "food", label: "Food & Drink", icon: "🍔", groups: ["food & drink"] },
  { key: "places", label: "Travel & Places", icon: "✈️", groups: ["travel & places"] },
  { key: "activities", label: "Activities", icon: "⚽", groups: ["activities"] },
  { key: "objects", label: "Objects", icon: "💡", groups: ["objects"] },
  { key: "symbols", label: "Symbols", icon: "❤️", groups: ["symbols"] },
  { key: "flags", label: "Flags", icon: "🏳️", groups: ["flags"] },
] as const;
const EMOJI_RESULTS_LIMIT = 36;
const RECENT_EMOJIS_KEY = "kanera-recent-emojis";
const RECENT_EMOJI_LIMIT = 12; // 2 rows of 6

function loadRecentEmojiNames(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_EMOJIS_KEY);
    const parsed: unknown = JSON.parse(raw ?? "null");
    return Array.isArray(parsed) ? parsed.filter((value: unknown): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function saveRecentEmojiNames(names: string[]): void {
  try {
    localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(names));
  } catch {
    // ignore storage errors (private browsing quota, etc.)
  }
}
const FENCED_MARKDOWN_RE = /^\s*```(?:md|markdown)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i;
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*:?-{3,}:?\s*\|?\s*$/m;
const MARKDOWN_BLOCK_RE = /(^|\n)\s*(#{1,6}\s+\S|[-*+]\s+\S|\d+\.\s+\S|>\s+\S|[-*+]\s+\[[ xX]\]\s+\S)/;
const TABLE_CELL_BLOCK_BREAK = "<br>";
const KANERA_USER_LINK_PREFIX = "kanera-user:";

type MarkdownTableSerializerState = {
  out: string;
  write(value: string): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
  renderInline(node: ProseMirrorNode): void;
};

type MarkdownBlockSerializerState = Pick<MarkdownTableSerializerState, "write" | "closeBlock">;

const PlainTextEmoji = Emoji.extend({
  addInputRules() {
    return [];
  },
  addPasteRules() {
    return [];
  },
  addProseMirrorPlugins() {
    return [];
  },
});

const KaneraMarkdownLinks = Extension.create({
  name: "kaneraMarkdownLinks",
  addStorage() {
    return {
      markdown: {
        parse: {
          // markdown-it rejects unknown schemes by default. Kanera stores user
          // mentions as durable kanera-user: links, so the editor parser must
          // allow that internal scheme when reopening saved markdown.
          setup(markdownit: { validateLink: (url: string) => boolean }) {
            const defaultValidate = markdownit.validateLink.bind(markdownit);
            markdownit.validateLink = (url: string) => url.startsWith(KANERA_USER_LINK_PREFIX) || defaultValidate(url);
          },
        },
      },
    };
  },
});

// tiptap-markdown reads storage.markdown, while Tiptap's table extension exposes
// separate v3 markdown hooks. Bridge that gap so edited tables save as GFM.
const MarkdownTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownTableSerializerState, node: ProseMirrorNode) {
          serializeMarkdownTable(state, node);
        },
        parse: {},
      },
    };
  },
});

// Tiptap v3 exposes native Markdown hooks, while tiptap-markdown reads its own
// storage contract. Keep the rule's Markdown representation explicit so a rule
// created by the input shortcut reopens as a rule instead of literal dashes.
const MarkdownHorizontalRule = HorizontalRule.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownBlockSerializerState, node: ProseMirrorNode) {
          state.write("---");
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

function serializeMarkdownTable(state: MarkdownTableSerializerState, node: ProseMirrorNode) {
  const rows = childNodes(node).map((row) => childNodes(row));
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columnCount === 0) {
    state.closeBlock(node);
    return;
  }

  ensureMarkdownBlockBoundary(state);
  const renderedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_unused, index) => serializeMarkdownTableCell(state, row[index])),
  );

  renderedRows.forEach((row, rowIndex) => {
    state.write(`| ${row.join(" | ")} |`);
    state.ensureNewLine();
    if (rowIndex === 0) {
      state.write(`| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`);
      state.ensureNewLine();
    }
  });
  state.closeBlock(node);
}

function ensureMarkdownBlockBoundary(state: Pick<MarkdownTableSerializerState, "out" | "write">) {
  if (!state.out.length) return;
  if (!state.out.endsWith("\n")) state.write("\n");
  if (!state.out.endsWith("\n\n")) state.write("\n");
}

function serializeMarkdownTableCell(state: MarkdownTableSerializerState, cell: ProseMirrorNode | undefined): string {
  if (!cell) return "";

  const parts: string[] = [];
  cell.forEach((child) => {
    const rendered = child.isTextblock ? renderInlineToString(state, child) : child.textContent;
    const normalized = rendered.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
    if (normalized) parts.push(normalized);
  });
  return parts.join(TABLE_CELL_BLOCK_BREAK).replace(/\|/g, "\\|");
}

function renderInlineToString(state: MarkdownTableSerializerState, node: ProseMirrorNode): string {
  const start = state.out.length;
  state.renderInline(node);
  const rendered = state.out.slice(start);
  state.out = state.out.slice(0, start);
  return rendered;
}

function childNodes(node: ProseMirrorNode): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  node.forEach((child) => nodes.push(child));
  return nodes;
}

@Component({
  selector: "k-description-editor",
  standalone: true,
  imports: [AvatarComponent, DescriptionEditorToolbarComponent, TooltipDirective],
  providers: [DescriptionEditorUploader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <div #shell class="de-shell" [class.de-compact]="compact()">
      @if (!compact()) {
        <k-description-editor-toolbar
          [editor]="editor"
          [tick]="tick()"
          (emojiRequested)="openEmojiPickerFromButton($event)"
          (attachRequested)="filePicker.click()"
        />
      }
      @if (compact() && bubbleMenuOpen()) {
        <div
          class="de-bubble-menu"
          [style.top.px]="bubbleMenuTop()"
          [style.left.px]="bubbleMenuLeft()"
        >
          <k-description-editor-toolbar
            [editor]="editor"
            [tick]="tick()"
            [compact]="true"
            (emojiRequested)="openEmojiPickerFromButton($event)"
            (attachRequested)="filePicker.click()"
          />
        </div>
      }

      <div #host class="de-host"></div>

      @if (uploader.uploading()) {
        <div class="de-uploading">
          <i class="ti ti-loader-2"></i> Uploading…
        </div>
      }
      @if (uploader.error(); as err) {
        <div class="de-error">{{ err }}</div>
      }
      @if (mentionOpen()) {
        <div class="de-mention-popover" [style.top.px]="mentionTop()" [style.left.px]="mentionLeft()" [style.max-height.px]="mentionMaxHeight()">
          @for (member of filteredMentionMembers(); track member.userId; let i = $index) {
            <button
              type="button"
              class="de-mention-option"
              [class.is-active]="i === mentionIndex()"
              (mousedown)="insertMention(member, $event)">
              <span class="de-mention-avatar">
                <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [size]="20" [userId]="member.userId" />
              </span>
              <span class="de-mention-name">{{ member.displayName }}</span>
            </button>
          } @empty {
            <div class="de-mention-empty">No matching users</div>
          }
        </div>
      }
      @if (emojiOpen()) {
        <div class="de-emoji-popover" [style.top.px]="emojiTop()" [style.left.px]="emojiLeft()">
          @if (emojiMode() === 'picker') {
            <div class="de-emoji-header">
              <div class="de-emoji-search">
                <i class="ti ti-search"></i>
                <input
                  type="search"
                  placeholder="Search emoji"
                  [value]="emojiQuery()"
                  (input)="setEmojiQuery($any($event.target).value)"
                  (keydown)="onEmojiSearchKeydown($event)"
                  autofocus
                />
              </div>
              <button type="button" class="de-emoji-close" (click)="dismissEmojiPicker()" kTooltip="Close emoji picker">
                <i class="ti ti-x"></i>
              </button>
            </div>
            @if (!emojiQuery().trim()) {
              <div class="de-emoji-tabs" role="tablist">
                @for (cat of emojiCategories; track cat.key) {
                  <button
                    type="button"
                    class="de-emoji-tab"
                    role="tab"
                    [class.is-active]="emojiCategory() === cat.key"
                    [kTooltip]="cat.label"
                    (mousedown)="setEmojiCategory(cat.key); $event.preventDefault()">
                    <span class="de-emoji-char">{{ cat.icon }}</span>
                  </button>
                }
              </div>
            }
          }
          <div class="de-emoji-grid">
            @for (emoji of filteredEmojis(); track emoji.name; let i = $index) {
              <button
                type="button"
                class="de-emoji-option"
                [class.is-active]="i === emojiIndex()"
                [kTooltip]="':' + emoji.shortcodes[0] + ':'"
                (mouseenter)="emojiIndex.set(i)"
                (mousedown)="insertEmoji(emoji, $event)">
                <span class="de-emoji-char">{{ emoji.emoji }}</span>
              </button>
            } @empty {
              <div class="de-emoji-empty">No matching emoji</div>
            }
          </div>
        </div>
      }

      <input
        #filePicker
        type="file"
        [accept]="allowedAttachmentAccept"
        (change)="onFileChosen($event)"
        hidden
      />

      @if (compact()) {
        <div class="de-compact-footer">
          <button type="button" class="de-tool" (click)="openEmojiPickerFromButton($event)" kTooltip="Insert emoji">
            <i class="ti ti-mood-smile"></i>
          </button>
          <button type="button" class="de-tool" (click)="filePicker.click()" kTooltip="Attach file" [disabled]="uploader.uploading()">
            <i class="ti ti-paperclip"></i>
          </button>
          <div class="de-compact-spacer"></div>
          @if (showCancel()) {
            <button type="button" class="ghost sm" (click)="cancel.emit()" [disabled]="saving()">Cancel</button>
          }
          <button type="button" class="primary sm" (click)="onSave()" [disabled]="saving() || uploader.uploading()">
            @if (saving()) {
              <i class="ti ti-loader-2 kanera-spin"></i>
            } @else {
              {{ submitLabel() }}
            }
          </button>
        </div>
      } @else {
        <div class="de-actions">
          @if (showCancel()) {
            <button type="button" class="ghost sm" (click)="cancel.emit()" [disabled]="saving()">Cancel</button>
          }
          <button type="button" class="primary sm" (click)="onSave()" [disabled]="saving() || uploader.uploading()">
            @if (saving()) {
              <i class="ti ti-loader-2 kanera-spin"></i> Saving…
            } @else {
              {{ submitLabel() }}
            }
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }

    .de-shell {
      display: flex;
      flex-direction: column;
      gap: 0;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md, 8px);
      background: var(--surface);
      overflow: hidden;
    }

    /* .de-tool is used by both the toolbar child and the compact footer paperclip,
       so its styles live in the parent (ViewEncapsulation.None) to apply to both. */
    .de-tool {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm, 4px);
      color: var(--text);
      font-size: 14px;
      cursor: pointer;
      transition: background-color 0.12s, border-color 0.12s;
    }

    /* :not(:disabled) raises specificity above the global button:hover primary rule
       (this component is ViewEncapsulation.None — see the mention-option note below)
       and also correctly suppresses the hover while the paperclip is disabled. */
    .de-tool:hover:not(:disabled) { background: var(--surface); border-color: var(--border); }
    .de-tool.is-active { background: var(--surface); border-color: var(--border-strong); }

    .de-host {
      padding: 10px 12px;
      min-height: 160px;
      max-height: 60vh;
      overflow-y: auto;
    }

    .de-compact .de-host {
      min-height: 72px;
    }

    .de-host .ProseMirror {
      outline: none;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text);
      background: var(--surface);
      min-height: 140px;
    }

    .de-compact .de-host .ProseMirror {
      min-height: 52px;
    }

    .de-host .ProseMirror p { margin: 0 0 10px; }
    .de-host .ProseMirror p:last-child { margin-bottom: 0; }
    .de-host .ProseMirror h1,
    .de-host .ProseMirror h2,
    .de-host .ProseMirror h3,
    .de-host .ProseMirror h4 {
      margin: 14px 0 8px;
      font-weight: 600;
      line-height: 1.3;
      color: var(--text);
    }
    .de-host .ProseMirror h1 { font-size: 20px; }
    .de-host .ProseMirror h2 { font-size: 17px; }
    .de-host .ProseMirror h3 { font-size: 15px; }
    .de-host .ProseMirror ul,
    .de-host .ProseMirror ol { padding-left: 22px; margin: 0 0 10px; }
    .de-host .ProseMirror li { margin: 2px 0; }
    .de-host .ProseMirror ul[data-type="taskList"] {
      list-style: none;
      padding-left: 0;
    }
    .de-host .ProseMirror li[data-type="taskItem"] {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin: 4px 0;
    }
    .de-host .ProseMirror li[data-type="taskItem"] > label {
      flex: 0 0 auto;
      line-height: 1.6;
    }
    .de-host .ProseMirror li[data-type="taskItem"] input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 4px 0 0;
      accent-color: var(--accent, #4f8cff);
    }
    .de-host .ProseMirror li[data-type="taskItem"] > div {
      flex: 1;
      min-width: 0;
    }
    .de-host .ProseMirror li[data-type="taskItem"] p {
      margin: 0;
    }
    .de-host .ProseMirror code {
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 12.5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--text);
    }
    .de-host .ProseMirror pre {
      background: var(--surface-2);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm, 4px);
      padding: 10px 12px;
      overflow-x: auto;
      margin: 0 0 10px;
      color: var(--text);
    }
    .de-host .ProseMirror pre code {
      background: transparent;
      border: none;
      padding: 0;
      color: inherit;
    }
    .de-host .ProseMirror blockquote {
      border-left: 3px solid var(--border-strong);
      margin: 0 0 10px;
      padding: 2px 12px;
      color: var(--text-muted);
    }
    .de-host .ProseMirror table {
      border-collapse: collapse;
      width: 100%;
      margin: 0 0 10px;
      font-size: 13px;
      table-layout: fixed;
    }
    .de-host .ProseMirror th,
    .de-host .ProseMirror td {
      border: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
      min-width: 1em;
      word-break: break-word;
    }
    .de-host .ProseMirror th {
      background: var(--surface-2);
      font-weight: 600;
    }
    .de-host .ProseMirror th p,
    .de-host .ProseMirror td p {
      margin: 0;
    }
    .de-host .ProseMirror img {
      max-width: 100%;
      max-height: 380px;
      border-radius: var(--radius-sm, 4px);
      border: 1px solid var(--border);
      display: block;
      margin: 8px 0;
    }
    .de-host .ProseMirror a {
      color: var(--accent, #4f8cff);
      text-decoration: underline;
    }
    .de-host .ProseMirror p.is-editor-empty:first-child::before {
      color: var(--text-muted);
      content: attr(data-placeholder);
      float: left;
      height: 0;
      pointer-events: none;
    }

    .de-uploading {
      padding: 6px 12px;
      background: var(--surface-2);
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .de-error {
      padding: 6px 12px;
      background: rgba(220, 38, 38, 0.08);
      border-top: 1px solid var(--border);
      color: #dc2626;
      font-size: 12px;
    }

    .de-mention-popover {
      position: fixed;
      width: 240px;
      max-height: 240px;
      box-sizing: border-box;
      overflow: auto;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md, 8px);
      background: var(--surface);
      box-shadow: 0 14px 36px rgba(15, 23, 42, 0.16);
      padding: 4px;
      z-index: 1100;
    }

    .de-emoji-popover {
      position: fixed;
      width: 282px;
      max-height: 332px;
      overflow: hidden;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md, 8px);
      background: var(--surface);
      box-shadow: 0 14px 36px rgba(15, 23, 42, 0.16);
      padding: 6px;
      z-index: 1110;
    }

    .de-bubble-menu {
      position: fixed;
      z-index: 1120;
      width: max-content;
      max-width: min(520px, calc(100vw - 12px));
      overflow: hidden;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md, 8px);
      background: var(--surface);
      box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
    }

    .de-bubble-menu .de-toolbar {
      overflow-x: auto;
      max-width: inherit;
      scrollbar-width: none;
    }

    .de-bubble-menu .de-toolbar::-webkit-scrollbar {
      display: none;
    }

    .de-emoji-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }

    .de-emoji-search {
      display: flex;
      align-items: stretch;
      gap: 6px;
      height: 30px;
      flex: 1;
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text-muted);
      overflow: hidden;
      transition: border-color 0.12s, box-shadow 0.12s;
    }

    .de-emoji-search:focus-within {
      border-color: var(--border-strong);
      box-shadow: 0 0 0 1px var(--border-strong);
    }

    .de-emoji-search > i {
      display: flex;
      align-items: center;
      padding: 0 6px 0 9px;
      color: var(--text-muted);
      flex-shrink: 0;
      font-size: 13px;
      pointer-events: none;
    }

    .de-emoji-search input {
      min-width: 0;
      flex: 1;
      align-self: center;
      height: 28px;
      padding: 2px 8px 0 4px;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--text);
      font-size: 13px;
      line-height: normal;
      box-shadow: none;
      appearance: none;
    }

    .de-emoji-search input::placeholder {
      color: var(--text-muted);
    }

    .de-emoji-search input::-webkit-search-cancel-button {
      display: none;
    }

    .de-emoji-close {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      border: 1px solid transparent;
      border-radius: var(--radius-sm, 4px);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 15px;
    }

    /* Scoped under the popover so it beats the global button:hover primary rule
       (ViewEncapsulation.None — see the mention-option note below). */
    .de-emoji-popover .de-emoji-close:hover {
      background: var(--surface-2);
      border-color: var(--border);
      color: var(--text);
    }

    .de-emoji-tabs {
      display: grid;
      grid-template-columns: repeat(9, minmax(0, 1fr));
      gap: 2px;
      padding-bottom: 6px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--border);
    }

    .de-emoji-tab {
      height: 28px;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border: 1px solid transparent;
      border-radius: var(--radius-sm, 4px);
      background: transparent;
      cursor: pointer;
      filter: grayscale(1) opacity(0.45);
      transition: filter 0.1s, background 0.1s, border-color 0.1s;
    }

    .de-emoji-tab .de-emoji-char {
      font-size: 14px;
    }

    .de-emoji-popover .de-emoji-tab:hover,
    .de-emoji-popover .de-emoji-tab.is-active {
      background: var(--surface-2);
      border-color: var(--border);
      filter: grayscale(1) opacity(0.75);
    }

    .de-emoji-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 2px;
      max-height: 230px;
      overflow: auto;
    }

    .de-emoji-option {
      height: 40px;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: var(--radius-sm, 4px);
      background: transparent;
      color: var(--text);
      cursor: pointer;
    }

    .de-emoji-popover .de-emoji-option:hover,
    .de-emoji-popover .de-emoji-option.is-active {
      background: var(--surface-2);
      border-color: var(--border);
    }

    .de-emoji-char {
      font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif;
      font-size: 20px;
      line-height: 1;
    }

    .de-emoji-empty {
      grid-column: 1 / -1;
      padding: 14px 8px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }

    .de-mention-option {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      border: 0;
      border-radius: var(--radius-sm, 4px);
      background: transparent;
      color: var(--text);
      text-align: left;
      padding: 5px 7px;
      cursor: pointer;
    }

    /* This component is ViewEncapsulation.None, so these styles are global and
       unscoped: a bare .de-mention-option:hover (0,2,0) loses to the global
       button:hover:not(:disabled) primary-button rule (0,2,1) and the item would
       flash the accent color. Scope under the popover to win, matching the neutral
       surface-2 hover used by the other popovers (move-list menu, pickers). */
    .de-mention-popover .de-mention-option:hover,
    .de-mention-popover .de-mention-option.is-active {
      background: var(--surface-2);
    }

    .de-mention-avatar {
      width: 20px;
      height: 20px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      color: var(--text);
      font-size: 11px;
      font-weight: 600;
      flex: 0 0 auto;
    }

    .de-mention-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .de-mention-name {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .de-mention-empty {
      padding: 8px 10px;
      color: var(--text-muted);
      font-size: 12px;
    }

    .de-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 8px 10px;
      background: var(--surface-2);
      border-top: 1px solid var(--border);
    }

    .de-compact-footer {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px 6px;
    }

    .de-compact-spacer { flex: 1; }
  `,
})
export class DescriptionEditorComponent implements AfterViewInit, OnDestroy {
  protected readonly uploader = inject(DescriptionEditorUploader);
  private readonly unsavedWork = inject(UnsavedWorkService);
  private readonly unsavedWorkSource = Symbol("description-editor");
  protected readonly allowedAttachmentAccept = DESCRIPTION_EDITOR_ACCEPT;

  readonly value = input.required<string>();
  /** Server-published value; differs from value when the editor opens a recovered local draft. */
  readonly unsavedBaseline = input<string | null>(null);
  readonly cardId = input.required<string>();
  readonly attachmentTarget = input<AttachmentTarget | null>(null);
  readonly attachmentSource = input<"description" | "comment">("description");
  readonly editable = input<boolean>(true);
  readonly mentionMembers = input<WireBoardMemberUser[]>([]);
  readonly compact = input<boolean>(false);
  readonly placeholder = input<string>("Write a description in markdown…");
  readonly submitLabel = input<string>("Save");
  readonly showCancel = input<boolean>(true);
  readonly autofocus = input<boolean>(true);
  readonly save = output<EditorSaveEvent>();
  readonly cancel = output<void>();
  readonly contentChange = output<string>();

  @ViewChild("host", { static: true }) hostRef!: ElementRef<HTMLDivElement>;
  @ViewChild("shell", { static: true }) shellRef!: ElementRef<HTMLDivElement>;

  editor: Editor | null = null;

  readonly saving = signal(false);
  readonly tick = signal(0);

  readonly mentionOpen = signal(false);
  readonly mentionQuery = signal("");
  readonly mentionIndex = signal(0);
  readonly mentionTop = signal(0);
  readonly mentionLeft = signal(0);
  readonly mentionMaxHeight = signal(240);
  private mentionRange: { from: number; to: number } | null = null;
  readonly filteredMentionMembers = signal<WireBoardMemberUser[]>([]);
  readonly emojiOpen = signal(false);
  readonly emojiQuery = signal("");
  readonly emojiIndex = signal(0);
  readonly emojiTop = signal(0);
  readonly emojiLeft = signal(0);
  readonly emojiMode = signal<"picker" | "suggestion">("picker");
  readonly emojiCategory = signal<string>("common");
  readonly emojiCategories = EMOJI_CATEGORIES;
  readonly filteredEmojis = signal<EmojiItem[]>([]);
  private emojiRange: { from: number; to: number } | null = null;
  private readonly emojiItems = tiptapEmojis.filter((emoji) => Boolean(emoji.emoji));
  readonly bubbleMenuOpen = signal(false);
  readonly bubbleMenuTop = signal(0);
  readonly bubbleMenuLeft = signal(0);
  private cleanMarkdown = "";

  constructor() {
    effect(() => {
      this.editor?.setEditable(this.editable());
    });
  }

  ngAfterViewInit() {
    this.editor = new Editor({
      element: this.hostRef.nativeElement,
      extensions: [
        StarterKit.configure({
          horizontalRule: false,
          link: {
            openOnClick: false,
            autolink: true,
            protocols: [{ scheme: "kanera-user" }],
            isAllowedUri: (url, { defaultValidate }) => url.startsWith(KANERA_USER_LINK_PREFIX) || defaultValidate(url),
          },
        }),
        Image.configure({ inline: false, allowBase64: false }),
        MarkdownHorizontalRule,
        MarkdownTable.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        TaskList,
        TaskItem.configure({ nested: true }),
        KaneraMarkdownLinks,
        PlainTextEmoji.configure({
          HTMLAttributes: { class: "de-inline-emoji" },
          enableEmoticons: true,
          suggestion: {
            char: "\u0000",
          },
        }),
        Placeholder.configure({ placeholder: this.placeholder() }),
        Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
      ],
      content: this.value() || "",
      editable: this.editable(),
      autofocus: this.autofocus() ? "end" : false,
      onTransaction: () => {
        this.tick.update((v) => v + 1);
        this.updateMentionPicker();
        this.updateEmojiSuggestion();
        this.updateBubbleMenu();
      },
      onUpdate: () => {
        const markdown = this.markdown();
        this.unsavedWork.setDirty(this.unsavedWorkSource, markdown.trim() !== this.cleanMarkdown.trim());
        this.contentChange.emit(markdown);
      },
      editorProps: {
        handleKeyDown: (_view, event) => this.handleEditorKeydown(event),
      },
    });

    // A recovered draft is already unsaved when the editor mounts, before another keystroke.
    this.cleanMarkdown = this.unsavedBaseline() ?? this.markdown();
    this.unsavedWork.setDirty(
      this.unsavedWorkSource,
      this.unsavedBaseline() !== null && this.value().trim() !== this.unsavedBaseline()!.trim(),
    );

    const shell = this.shellRef.nativeElement;
    shell.addEventListener("keydown", this.handleEditorKeydownCapture, { capture: true });
    shell.addEventListener("paste", this.handlePaste, { capture: true });
    shell.addEventListener("dragenter", this.handleDragOver, { capture: true });
    shell.addEventListener("dragover", this.handleDragOver, { capture: true });
    shell.addEventListener("drop", this.handleDrop, { capture: true });
    document.addEventListener("mousedown", this.handleDocumentMouseDown);
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("scroll", this.handleViewportChange, true);
  }

  ngOnDestroy() {
    this.unsavedWork.setDirty(this.unsavedWorkSource, false);
    document.removeEventListener("mousedown", this.handleDocumentMouseDown);
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("scroll", this.handleViewportChange, true);
    if (this.editor) {
      const shell = this.shellRef.nativeElement;
      shell.removeEventListener("keydown", this.handleEditorKeydownCapture, { capture: true });
      shell.removeEventListener("paste", this.handlePaste, { capture: true });
      shell.removeEventListener("dragenter", this.handleDragOver, { capture: true });
      shell.removeEventListener("dragover", this.handleDragOver, { capture: true });
      shell.removeEventListener("drop", this.handleDrop, { capture: true });
      this.editor.destroy();
      this.editor = null;
    }
  }

  insertMention(member: WireBoardMemberUser, event?: Event) {
    event?.preventDefault();
    if (!this.editor || !this.mentionRange) return;
    const label = member.displayName.replace(/[[\]\n\r]/g, " ").trim() || "User";
    this.editor
      .chain()
      .focus()
      .deleteRange(this.mentionRange)
      .insertContent([
        { type: "text", text: "@" },
        { type: "text", text: label, marks: [{ type: "link", attrs: { href: `${KANERA_USER_LINK_PREFIX}${member.userId}` } }] },
        { type: "text", text: " " },
      ])
      .run();
    this.closeMentionPicker();
  }

  private readonly handleEditorKeydownCapture = (event: KeyboardEvent) => {
    const target = event.target;
    if (event.key !== "Tab" || !(target instanceof HTMLElement) || !target.closest(".ProseMirror")) return;
    if (!this.handleEditorKeydown(event)) return;
    event.stopImmediatePropagation();
  };

  private handleEditorKeydown(event: KeyboardEvent): boolean {
    if (this.handleEmojiKeydown(event)) return true;
    if (this.handleMentionKeydown(event)) return true;
    if (this.handleListIndentKeydown(event)) return true;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!this.saving() && !this.uploader.uploading()) this.onSave();
      return true;
    }
    return false;
  }

  private handleMentionKeydown(event: KeyboardEvent): boolean {
    if (!this.mentionOpen()) return false;
    const members = this.filteredMentionMembers();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.mentionIndex.set(members.length ? (this.mentionIndex() + 1) % members.length : 0);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.mentionIndex.set(members.length ? (this.mentionIndex() - 1 + members.length) % members.length : 0);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (members.length === 0) return false;
      event.preventDefault();
      this.insertMention(members[this.mentionIndex()]!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeMentionPicker();
      return true;
    }
    return false;
  }

  private handleListIndentKeydown(event: KeyboardEvent): boolean {
    if (!this.editor || event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return false;
    event.preventDefault();

    // Inside markdown lists, Tab owns list nesting instead of moving focus to
    // the action buttons. Outside lists we still consume it so dialog focus
    // does not jump, but only add a lightweight markdown-space indent.
    const chain = this.editor.chain().focus();
    const listItemType = this.editor.isActive("taskItem") ? "taskItem" : this.editor.isActive("listItem") ? "listItem" : null;
    if (listItemType) {
      if (event.shiftKey) {
        chain.liftListItem(listItemType).run();
      } else {
        chain.sinkListItem(listItemType).run();
      }
      return true;
    }

    if (!event.shiftKey) {
      chain.insertContent("    ").run();
    } else {
      this.editor.commands.focus();
    }
    return true;
  }

  private updateMentionPicker() {
    if (!this.editor) return;
    const { state } = this.editor;
    const { from, empty } = state.selection;
    if (!empty) {
      this.closeMentionPicker();
      return;
    }
    const parentStart = from - state.selection.$from.parentOffset;
    const textBefore = state.doc.textBetween(parentStart, from, "\n", "\n");
    const match = /(?:^|\s)@([^\s@[\]()]{0,40})$/.exec(textBefore);
    if (!match) {
      this.closeMentionPicker();
      return;
    }
    const query = match[1] ?? "";
    const triggerLength = query.length + 1;
    this.mentionRange = { from: from - triggerLength, to: from };
    this.mentionQuery.set(query);
    const normalized = query.toLowerCase();
    const members = this.mentionMembers()
      .filter((member) => {
        if (!normalized) return true;
        return member.displayName.toLowerCase().includes(normalized);
      })
      .slice(0, 8);
    this.filteredMentionMembers.set(members);
    this.mentionIndex.set(Math.min(this.mentionIndex(), Math.max(0, members.length - 1)));
    this.positionMentionPopover(from - triggerLength, members.length);
    this.mentionOpen.set(true);
  }

  private positionMentionPopover(pos: number, optionCount: number) {
    if (!this.editor) return;
    // The mention range starts before the @. Bias toward the trigger itself so
    // browser text-layout changes while the query grows do not pull the menu
    // toward the live cursor.
    const caret = this.editor.view.coordsAtPos(pos + 1, -1);
    const popoverWidth = 240;
    const popoverMaxHeight = 240;
    const optionHeight = 36;
    const popoverChromeHeight = 10;
    const emptyHeight = 33;
    const popoverHeight = optionCount
      ? Math.min(popoverMaxHeight, optionCount * optionHeight + popoverChromeHeight)
      : emptyHeight + popoverChromeHeight;
    const margin = 6;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const left = Math.max(margin, Math.min(caret.left, viewportW - popoverWidth - margin));
    const spaceBelow = viewportH - caret.bottom;
    const opensBelow = spaceBelow >= popoverMaxHeight + margin;
    const availableAbove = Math.max(emptyHeight + popoverChromeHeight, caret.top - margin - 4);
    const maxHeight = opensBelow ? popoverMaxHeight : Math.min(popoverMaxHeight, availableAbove);
    const renderedHeight = Math.min(popoverHeight, maxHeight);
    const top = opensBelow
      ? caret.bottom + 4
      : Math.max(margin, caret.top - renderedHeight - 4);
    this.mentionTop.set(top);
    this.mentionLeft.set(left);
    this.mentionMaxHeight.set(maxHeight);
  }

  private closeMentionPicker() {
    this.mentionOpen.set(false);
    this.mentionQuery.set("");
    this.mentionIndex.set(0);
    this.mentionRange = null;
    this.filteredMentionMembers.set([]);
  }

  openEmojiPickerFromButton(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.editor || !this.editable()) return;
    this.closeMentionPicker();
    this.emojiRange = null;
    this.emojiMode.set("picker");
    this.emojiCategory.set("common");
    this.emojiQuery.set("");
    this.filteredEmojis.set(this.commonEmojis());
    this.emojiIndex.set(0);
    this.positionEmojiPopoverForRect((event.currentTarget as HTMLElement).getBoundingClientRect());
    this.emojiOpen.set(true);
    queueMicrotask(() => {
      const input = this.shellRef.nativeElement.querySelector<HTMLInputElement>(".de-emoji-search input");
      input?.focus();
    });
  }

  setEmojiQuery(query: string) {
    this.emojiQuery.set(query);
    this.filteredEmojis.set(
      query.trim() ? this.searchEmojis(query) : this.emojisForCategory(this.emojiCategory()),
    );
    this.emojiIndex.set(0);
  }

  onEmojiSearchKeydown(event: KeyboardEvent) {
    if (this.handleEmojiKeydown(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeEmojiPicker();
      this.editor?.commands.focus();
    }
  }

  dismissEmojiPicker() {
    this.closeEmojiPicker();
    this.editor?.commands.focus();
  }

  insertEmoji(emoji: EmojiItem, event?: Event) {
    event?.preventDefault();
    if (!this.editor || !emoji.emoji) return;
    const content = this.emojiMode() === "suggestion" ? `${emoji.emoji} ` : emoji.emoji;
    const range = this.emojiRange;
    const textNode = { type: "text", text: content };
    const chain = this.editor.chain().focus();
    if (range) {
      chain.insertContentAt(range, textNode).run();
    } else {
      chain.insertContent(textNode).run();
    }
    const recent = loadRecentEmojiNames().filter((n) => n !== emoji.name);
    recent.unshift(emoji.name);
    saveRecentEmojiNames(recent.slice(0, RECENT_EMOJI_LIMIT));
    this.closeEmojiPicker();
  }

  private handleEmojiKeydown(event: KeyboardEvent): boolean {
    if (!this.emojiOpen()) return false;
    const emojis = this.filteredEmojis();
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      this.emojiIndex.set(emojis.length ? (this.emojiIndex() + 1) % emojis.length : 0);
      return true;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      this.emojiIndex.set(emojis.length ? (this.emojiIndex() - 1 + emojis.length) % emojis.length : 0);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (emojis.length === 0) return false;
      event.preventDefault();
      this.insertEmoji(emojis[this.emojiIndex()]!);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.closeEmojiPicker();
      return true;
    }
    return false;
  }

  private updateEmojiSuggestion() {
    if (!this.editor || (this.emojiOpen() && this.emojiMode() === "picker")) return;
    const { state } = this.editor;
    const { from, empty } = state.selection;
    if (!empty) {
      this.closeEmojiPicker();
      return;
    }
    const parentStart = from - state.selection.$from.parentOffset;
    const textBefore = state.doc.textBetween(parentStart, from, "\n", "\n");
    const match = /(?:^|\s):([a-zA-Z0-9_+-]{1,40})$/.exec(textBefore);
    if (!match) {
      this.closeEmojiPicker();
      return;
    }
    const query = match[1] ?? "";
    const triggerLength = query.length + 1;
    this.closeMentionPicker();
    this.emojiRange = { from: from - triggerLength, to: from };
    this.emojiMode.set("suggestion");
    this.emojiQuery.set(query);
    this.filteredEmojis.set(this.searchEmojis(query).slice(0, 8));
    this.emojiIndex.set(Math.min(this.emojiIndex(), Math.max(0, this.filteredEmojis().length - 1)));
    this.positionEmojiPopover(from - triggerLength);
    this.emojiOpen.set(true);
  }

  private positionEmojiPopover(pos: number) {
    if (!this.editor) return;
    this.positionEmojiPopoverForRect(this.editor.view.coordsAtPos(pos));
  }

  private positionEmojiPopoverForRect(rect: Pick<DOMRect, "left" | "top" | "bottom">) {
    const popoverWidth = 282;
    const popoverMaxHeight = 332;
    const margin = 6;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const left = Math.max(margin, Math.min(rect.left, viewportW - popoverWidth - margin));
    const spaceBelow = viewportH - rect.bottom;
    const top = spaceBelow >= popoverMaxHeight + margin
      ? rect.bottom + 4
      : Math.max(margin, rect.top - popoverMaxHeight - 4);
    this.emojiTop.set(top);
    this.emojiLeft.set(left);
  }

  private closeEmojiPicker() {
    this.emojiOpen.set(false);
    this.emojiQuery.set("");
    this.emojiIndex.set(0);
    this.emojiCategory.set("common");
    this.emojiRange = null;
    this.filteredEmojis.set([]);
  }

  private updateBubbleMenu() {
    if (!this.editor || !this.compact() || !this.editable()) {
      this.bubbleMenuOpen.set(false);
      return;
    }

    const { from, to, empty } = this.editor.state.selection;
    if (empty || this.mentionOpen() || this.emojiOpen()) {
      this.bubbleMenuOpen.set(false);
      return;
    }

    // Compact comment editors do not reserve toolbar space. Anchor the toolbar
    // to selected text so formatting remains available while editing comments.
    const start = this.editor.view.coordsAtPos(from);
    const end = this.editor.view.coordsAtPos(to);
    const menuWidth = 520;
    const margin = 6;
    const selectionLeft = Math.min(start.left, end.left);
    const selectionRight = Math.max(start.right, end.right);
    const selectionTop = Math.min(start.top, end.top);
    const viewportW = window.innerWidth;
    const left = Math.max(margin, Math.min((selectionLeft + selectionRight) / 2 - menuWidth / 2, viewportW - menuWidth - margin));
    const top = Math.max(margin, selectionTop - 44);
    this.bubbleMenuLeft.set(left);
    this.bubbleMenuTop.set(top);
    this.bubbleMenuOpen.set(true);
  }

  private readonly handleViewportChange = () => {
    this.updateBubbleMenu();
  };

  private commonEmojis(): EmojiItem[] {
    const recentNames = loadRecentEmojiNames();
    const recentSet = new Set(recentNames);
    const recent = recentNames
      .map((name) => this.emojiItems.find((e) => e.name === name))
      .filter((e): e is EmojiItem => Boolean(e?.emoji));
    const popular = POPULAR_EMOJI_SHORTCODES
      .map((shortcode) => shortcodeToEmoji(shortcode, this.emojiItems))
      .filter((e): e is EmojiItem => Boolean(e?.emoji) && !recentSet.has(e!.name));
    const combined = [...recent, ...popular];
    return combined.length ? combined : this.emojiItems.slice(0, 24);
  }

  private emojisForCategory(key: string): EmojiItem[] {
    if (key === "common") return this.commonEmojis();
    const cat = EMOJI_CATEGORIES.find((c) => c.key === key);
    if (!cat || !("groups" in cat)) return this.commonEmojis();
    // The tiptap dataset places smiley faces in an empty group alongside
    // regional-indicator letters (🇦–🇿); exclude those to keep the Smileys tab clean.
    return this.emojiItems.filter(
      (e) => (cat.groups as readonly string[]).includes(e.group ?? "")
        && !e.name.startsWith("regional_indicator_"),
    );
  }

  setEmojiCategory(key: string) {
    this.emojiCategory.set(key);
    this.filteredEmojis.set(this.emojisForCategory(key));
    this.emojiIndex.set(0);
    queueMicrotask(() => {
      const input = this.shellRef.nativeElement.querySelector<HTMLInputElement>(".de-emoji-search input");
      input?.focus();
    });
  }

  private searchEmojis(query: string): EmojiItem[] {
    const normalized = query.trim().toLowerCase().replace(/^:/, "");
    if (!normalized) return this.commonEmojis();
    return this.emojiItems
      .filter((emoji) =>
        emoji.name.toLowerCase().includes(normalized)
        || emoji.shortcodes.some((shortcode) => shortcode.toLowerCase().includes(normalized))
        || emoji.tags.some((tag) => tag.toLowerCase().includes(normalized)),
      )
      .slice(0, EMOJI_RESULTS_LIMIT);
  }

  onFileChosen(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void this.uploader.uploadAndInsert(file, this.editor, this.uploadTarget(), this.attachmentSource());
  }

  private readonly handlePaste = (e: ClipboardEvent) => {
    if (!this.editable()) return;
    const files = this.allowedClipboardFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      for (const file of files) {
        void this.uploader.uploadAndInsert(file, this.editor, this.uploadTarget(), this.attachmentSource());
      }
      return;
    }

    const markdown = this.pastedMarkdownSource(e.clipboardData);
    if (!markdown || !this.editor) return;

    e.preventDefault();
    this.insertMarkdownSource(markdown);
  };

  private unwrapMarkdownFence(value: string): string | null {
    const match = FENCED_MARKDOWN_RE.exec(value);
    if (!match) return null;

    const markdown = match[1]?.trim();
    if (!markdown || !this.looksLikeMarkdownDocument(markdown)) return null;
    return markdown;
  }

  private pastedMarkdownSource(data: DataTransfer | null): string | null {
    const pasted = data?.getData("text/plain")?.trim() ?? "";
    if (!pasted) return null;
    const unfenced = this.unwrapMarkdownFence(pasted);
    if (unfenced) return unfenced;
    // Prefer plain text for Markdown-shaped documents because some source apps
    // put copied .md content on the clipboard as preformatted HTML.
    return this.looksLikeMarkdownDocument(pasted) ? pasted : null;
  }

  private insertMarkdownSource(markdown: string) {
    this.editor?.chain().focus().insertContent(markdown).run();
  }

  private looksLikeMarkdownDocument(markdown: string): boolean {
    if (this.looksLikeMarkdownTable(markdown)) return true;
    return MARKDOWN_BLOCK_RE.test(markdown);
  }

  private looksLikeMarkdownTable(markdown: string): boolean {
    if (!TABLE_SEPARATOR_RE.test(markdown)) return false;
    const lines = markdown.split(/\r?\n/);
    const separatorIndex = lines.findIndex((line) => TABLE_SEPARATOR_RE.test(line));
    // Tables need a header before the separator and a body row after it;
    // otherwise code with pipe characters can be mistaken for markdown.
    return separatorIndex > 0
      && separatorIndex < lines.length - 1
      && lines[separatorIndex - 1]?.includes("|")
      && lines[separatorIndex + 1]?.includes("|");
  }

  private readonly handleDocumentMouseDown = (event: MouseEvent) => {
    if (!this.emojiOpen()) return;
    const target = event.target;
    if (target instanceof Node && this.shellRef.nativeElement.contains(target)) return;
    this.closeEmojiPicker();
  };

  private allowedClipboardFiles(data: DataTransfer | null): File[] {
    if (!data) return [];

    const files: File[] = [];
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file && this.uploader.isAllowedFile(file)) files.push(file);
    }

    if (files.length > 0) return files;
    return Array.from(data.files ?? []).filter((file) => this.uploader.isAllowedFile(file));
  }

  private readonly handleDragOver = (e: DragEvent) => {
    if (!this.editable() || !this.isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  private readonly handleDrop = (e: DragEvent) => {
    if (!this.editable() || !this.isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const allowed = Array.from(files).filter((f) => this.uploader.isAllowedFile(f));
    if (allowed.length === 0) return;
    for (const f of allowed) {
      void this.uploader.uploadAndInsert(f, this.editor, this.uploadTarget(), this.attachmentSource());
    }
  };

  private isFileDrag(data: DataTransfer | null): boolean {
    if (!data) return false;
    if (Array.from(data.types ?? []).some((type) => type === "Files" || type === "application/x-moz-file")) return true;
    return Array.from(data.items ?? []).some((item) => item.kind === "file");
  }

  onSave() {
    if (!this.editor || !this.editable()) return;
    const md = this.markdown();
    this.saving.set(true);
    this.save.emit({ markdown: md, attachmentIds: this.uploader.attachmentIdsSnapshot() });
  }

  markdown(): string {
    if (!this.editor) return "";
    const markdown = (this.editor.storage as { markdown?: { getMarkdown?: () => string } })
      .markdown?.getMarkdown?.() ?? "";
    return this.markdownShortcodesToUnicode(this.normalizeMarkdownTables(markdown));
  }

  reset() {
    this.uploader.reset();
    this.saving.set(false);
    this.editor?.commands.setContent("");
    this.cleanMarkdown = "";
    this.unsavedWork.setDirty(this.unsavedWorkSource, false);
  }

  setMarkdown(markdown: string) {
    this.editor?.commands.setContent(markdown || "");
    this.contentChange.emit(this.markdown());
  }

  /**
   * Prepend markdown at the start of the document, leaving the existing draft
   * intact. Used to inject a quoted reply when the composer is already open.
   */
  prependMarkdown(markdown: string) {
    // insertContentAt clamps the position; 0 resolves to the document start.
    this.editor?.chain().insertContentAt(0, markdown).focus("end").run();
  }

  setSaving(v: boolean) {
    this.saving.set(v);
  }

  private uploadTarget(): AttachmentTarget {
    return this.attachmentTarget() ?? { kind: "card", id: this.cardId() };
  }

  private normalizeMarkdownTables(markdown: string): string {
    const lines = markdown.split(/\r?\n/);
    const out: string[] = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index] ?? "";
      const next = lines[index + 1] ?? "";
      if (!line.includes("|") || !TABLE_SEPARATOR_RE.test(next)) {
        out.push(line);
        index += 1;
        continue;
      }

      while (out.length > 0 && !out[out.length - 1]?.trim()) out.pop();
      if (out.length > 0) out.push("");
      out.push(line, next);
      index += 2;

      while (index < lines.length && (lines[index] ?? "").includes("|") && !TABLE_SEPARATOR_RE.test(lines[index] ?? "")) {
        out.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length && (lines[index] ?? "").trim()) out.push("");
    }

    return out.join("\n");
  }

  private markdownShortcodesToUnicode(markdown: string): string {
    return markdown.replace(/:([a-zA-Z0-9_+-]+):/g, (match, shortcode: string) => {
      return shortcodeToEmoji(shortcode, this.emojiItems)?.emoji ?? match;
    });
  }
}
