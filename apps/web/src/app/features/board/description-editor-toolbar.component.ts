import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, input, output, signal } from "@angular/core";
import type { Editor } from "@tiptap/core";
import { TooltipDirective } from "../../shared/tooltip.directive";

@Component({
  selector: "k-description-editor-toolbar",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="de-toolbar" [class.de-toolbar-compact]="compact()">
      <button type="button" class="de-tool" [class.is-active]="isActiveBold()" (click)="cmd('toggleBold')" kTooltip="Bold (Ctrl+B)">
        <i class="ti ti-bold"></i>
      </button>
      <button type="button" class="de-tool" [class.is-active]="isActiveItalic()" (click)="cmd('toggleItalic')" kTooltip="Italic (Ctrl+I)">
        <i class="ti ti-italic"></i>
      </button>
      <button type="button" class="de-tool" [class.is-active]="isActiveStrike()" (click)="cmd('toggleStrike')" kTooltip="Strikethrough">
        <i class="ti ti-strikethrough"></i>
      </button>
      <span class="de-sep"></span>
      <button type="button" class="de-tool" [class.is-active]="isActiveH2()" (click)="toggleHeading(2)" kTooltip="Heading 2">
        <i class="ti ti-h-2"></i>
      </button>
      <button type="button" class="de-tool" [class.is-active]="isActiveH3()" (click)="toggleHeading(3)" kTooltip="Heading 3">
        <i class="ti ti-h-3"></i>
      </button>
      <span class="de-sep"></span>
      <button type="button" class="de-tool" [class.is-active]="isActiveBulletList()" (click)="cmd('toggleBulletList')" kTooltip="Bullet list">
        <i class="ti ti-list"></i>
      </button>
      <button type="button" class="de-tool" [class.is-active]="isActiveOrderedList()" (click)="cmd('toggleOrderedList')" kTooltip="Numbered list">
        <i class="ti ti-list-numbers"></i>
      </button>
      <button type="button" class="de-tool" [class.is-active]="isActiveTaskList()" (click)="cmd('toggleTaskList')" kTooltip="Task list">
        <i class="ti ti-list-check"></i>
      </button>
      <span class="de-sep"></span>
      <button type="button" class="de-tool" [class.is-active]="isActiveCode()" (click)="cmd('toggleCode')" kTooltip="Inline code">
        <i class="ti ti-code"></i>
      </button>
      <button type="button" class="de-tool" [class.is-active]="isActiveCodeBlock()" (click)="cmd('toggleCodeBlock')" kTooltip="Code block">
        <i class="ti ti-source-code"></i>
      </button>
      <button type="button" class="de-tool" [class.is-active]="isActiveBlockquote()" (click)="cmd('toggleBlockquote')" kTooltip="Quote">
        <i class="ti ti-quote"></i>
      </button>
      <span class="de-sep"></span>
      <button type="button" class="de-tool" [class.is-active]="isActiveLink()" (click)="promptLink()" kTooltip="Link">
        <i class="ti ti-link"></i>
      </button>
      @if (!compact()) {
        <button type="button" class="de-tool" (click)="emojiRequested.emit($event)" kTooltip="Insert emoji">
          <i class="ti ti-mood-smile"></i>
        </button>
        <button type="button" class="de-tool" (click)="attachRequested.emit()" kTooltip="Attach file">
          <i class="ti ti-photo"></i>
        </button>
        <span class="de-sep"></span>
      }
      <button type="button" class="de-tool" (click)="cmd('undo')" kTooltip="Undo">
        <i class="ti ti-arrow-back-up"></i>
      </button>
      <button type="button" class="de-tool" (click)="cmd('redo')" kTooltip="Redo">
        <i class="ti ti-arrow-forward-up"></i>
      </button>
    </div>

    @if (linkPopoverOpen()) {
      <div class="de-link-bar">
        <i class="ti ti-link de-link-icon"></i>
        <input
          class="de-link-input"
          type="url"
          placeholder="https://example.com"
          [value]="linkUrl()"
          (input)="linkUrl.set($any($event.target).value)"
          (keydown)="onLinkKeydown($event)"
          autofocus
        />
        <button type="button" class="de-link-apply" (click)="applyLink()">Apply</button>
        <button type="button" class="ghost xs" (click)="cancelLink()">Cancel</button>
      </div>
    }
  `,
  styles: `
    .de-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 2px;
      padding: 6px 8px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }

    .de-toolbar-compact {
      flex-wrap: nowrap;
      border-bottom: 0;
      background: var(--surface);
    }

    .de-sep {
      width: 1px;
      height: 18px;
      background: var(--border);
      margin: 0 4px;
    }

    .de-link-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }

    .de-link-icon {
      font-size: 14px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .de-link-input {
      flex: 1;
      height: 28px;
      padding: 0 8px;
      font-size: 13px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm, 4px);
      color: var(--text);
      outline: none;
      &:focus { border-color: var(--accent, #4f8cff); }
    }

    .de-link-apply {
      height: 28px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 500;
      background: var(--accent, #4f8cff);
      border: 1px solid var(--accent, #4f8cff);
      border-radius: var(--radius-sm, 4px);
      color: #fff;
      cursor: pointer;
      white-space: nowrap;
      &:hover { opacity: 0.9; }
    }
  `,
})
export class DescriptionEditorToolbarComponent {
  readonly editor = input<Editor | null>(null);
  // Parent increments this on every editor transaction so isActive() recomputes.
  readonly tick = input<number>(0);
  readonly compact = input<boolean>(false);
  readonly attachRequested = output<void>();
  readonly emojiRequested = output<MouseEvent>();

  readonly linkPopoverOpen = signal(false);
  readonly linkUrl = signal("");

  // Each toolbar button reads tick() so OnPush re-runs the binding when the editor
  // selection changes. Wrapping in computed() keeps the dependency obvious.
  readonly isActiveBold = computed(() => this.isActive("bold"));
  readonly isActiveItalic = computed(() => this.isActive("italic"));
  readonly isActiveStrike = computed(() => this.isActive("strike"));
  readonly isActiveBulletList = computed(() => this.isActive("bulletList"));
  readonly isActiveOrderedList = computed(() => this.isActive("orderedList"));
  readonly isActiveTaskList = computed(() => this.isActive("taskList"));
  readonly isActiveCode = computed(() => this.isActive("code"));
  readonly isActiveCodeBlock = computed(() => this.isActive("codeBlock"));
  readonly isActiveBlockquote = computed(() => this.isActive("blockquote"));
  readonly isActiveLink = computed(() => this.isActive("link"));
  readonly isActiveH2 = computed(() => this.isActiveHeading(2));
  readonly isActiveH3 = computed(() => this.isActiveHeading(3));

  cmd(name: string) {
    const editor = this.editor();
    if (!editor) return;
    const chain = editor.chain().focus() as unknown as Record<string, () => { run: () => boolean }>;
    chain[name]?.().run();
  }

  toggleHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
    this.editor()?.chain().focus().toggleHeading({ level }).run();
  }

  private isActive(name: string): boolean {
    this.tick();
    return this.editor()?.isActive(name) ?? false;
  }

  private isActiveHeading(level: number): boolean {
    this.tick();
    return this.editor()?.isActive("heading", { level }) ?? false;
  }

  promptLink() {
    const editor = this.editor();
    if (!editor) return;
    const current = (editor.getAttributes("link")["href"] as string | undefined) ?? "";
    this.linkUrl.set(current);
    this.linkPopoverOpen.set(true);
  }

  applyLink() {
    const editor = this.editor();
    if (!editor) return;
    const url = this.linkUrl().trim();
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    this.linkPopoverOpen.set(false);
  }

  cancelLink() {
    this.linkPopoverOpen.set(false);
    this.editor()?.commands.focus();
  }

  onLinkKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") { event.preventDefault(); this.applyLink(); }
    if (event.key === "Escape") { event.preventDefault(); this.cancelLink(); }
  }
}
