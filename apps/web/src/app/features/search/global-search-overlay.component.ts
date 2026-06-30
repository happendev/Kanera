import type { ElementRef } from "@angular/core";
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import type {
  AttachmentSearchResult,
  CardSearchResult,
  CommentSearchResult,
  NoteSearchResult,
} from "@kanera/shared/dto";
import { GlobalSearchService } from "../../core/search/global-search.service";

type FlatResult =
  | { kind: "card"; data: CardSearchResult }
  | { kind: "note"; data: NoteSearchResult }
  | { kind: "comment"; data: CommentSearchResult }
  | { kind: "attachment"; data: AttachmentSearchResult };

@Component({
  selector: "k-global-search-overlay",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (search.isOpen()) {
      <div class="backdrop" (click)="search.close()">
        <div class="panel" role="dialog" aria-label="Search" (click)="$event.stopPropagation()">
          <div class="search-row">
            <i class="ti ti-search"></i>
            <input
              #searchInput
              type="text"
              class="search-input"
              placeholder="Search cards, notes, comments, attachments…"
              autocomplete="off"
              spellcheck="false"
              role="combobox"
              aria-autocomplete="list"
              aria-label="Search"
              aria-controls="global-search-results"
              [attr.aria-expanded]="hasQuery()"
              [attr.aria-activedescendant]="highlightedResultId()"
              [value]="search.query()"
              (input)="search.query.set($any($event.target).value)"
              (keydown)="onKeydown($event)"
            />
            @if (search.loading()) {
              <i class="ti ti-loader-2 spin"></i>
            }
            <kbd class="esc">Esc</kbd>
          </div>

          @if (hasQuery()) {
            <div id="global-search-results" class="results" role="listbox" aria-label="Search results">
              @if (flat().length === 0 && !search.loading()) {
                <div class="empty" role="status" aria-live="polite">
                  <i class="ti ti-mood-empty"></i>
                  <span>No results for "{{ search.query() }}"</span>
                </div>
              }

              @if (cards().length) {
                <div class="group-label"><i class="ti ti-layout-kanban"></i> Cards</div>
                @for (c of cards(); track c.id; let i = $index) {
                  <button
                    [id]="resultId(i)"
                    type="button"
                    class="row"
                    role="option"
                    [class.active]="highlightedIndex() === i"
                    [attr.aria-selected]="highlightedIndex() === i"
                    (mouseenter)="highlightedIndex.set(i)"
                    (click)="select({ kind: 'card', data: c })"
                  >
                    <span class="row-icon">
                      <i [class]="'ti ti-' + (c.boardIcon || 'layout-kanban')"
                         [style.color]="c.boardColor ? 'var(--color-' + c.boardColor + ')' : null"></i>
                    </span>
                    <span class="row-main">
                      <span class="row-title">{{ c.cardTitle }}</span>
                      <!-- innerHTML is safe: Postgres ts_headline escapes the source text and only emits <mark> tags. -->
                      <span class="snippet" [innerHTML]="c.snippet"></span>
                      <span class="meta">{{ c.boardName }} · {{ c.listName }}</span>
                    </span>
                  </button>
                }
              }

              @if (notes().length) {
                <div class="group-label"><i class="ti ti-notebook"></i> Notes</div>
                @for (n of notes(); track n.id; let i = $index) {
                  <button
                    [id]="resultId(notesOffset() + i)"
                    type="button"
                    class="row"
                    role="option"
                    [class.active]="highlightedIndex() === notesOffset() + i"
                    [attr.aria-selected]="highlightedIndex() === notesOffset() + i"
                    (mouseenter)="highlightedIndex.set(notesOffset() + i)"
                    (click)="select({ kind: 'note', data: n })"
                  >
                    <span class="row-icon">
                      @if (n.boardId) {
                        <i [class]="'ti ti-' + (n.boardIcon || 'layout-kanban')"
                           [style.color]="n.boardColor ? 'var(--color-' + n.boardColor + ')' : null"></i>
                      } @else {
                        <i class="ti ti-notebook"></i>
                      }
                    </span>
                    <span class="row-main">
                      <span class="row-title">{{ n.title }}</span>
                      <span class="snippet" [innerHTML]="n.snippet"></span>
                      <span class="meta">{{ n.boardName ?? n.workspaceName }}</span>
                    </span>
                  </button>
                }
              }

              @if (comments().length) {
                <div class="group-label"><i class="ti ti-message"></i> Comments</div>
                @for (c of comments(); track c.id; let i = $index) {
                  <button
                    [id]="resultId(commentsOffset() + i)"
                    type="button"
                    class="row"
                    role="option"
                    [class.active]="highlightedIndex() === commentsOffset() + i"
                    [attr.aria-selected]="highlightedIndex() === commentsOffset() + i"
                    (mouseenter)="highlightedIndex.set(commentsOffset() + i)"
                    (click)="select({ kind: 'comment', data: c })"
                  >
                    <span class="row-icon">
                      <i [class]="'ti ti-' + (c.boardIcon || 'layout-kanban')"
                         [style.color]="c.boardColor ? 'var(--color-' + c.boardColor + ')' : null"></i>
                    </span>
                    <span class="row-main">
                      <span class="row-title">{{ c.cardTitle }}</span>
                      <span class="snippet" [innerHTML]="c.snippet"></span>
                      <span class="meta">{{ c.boardName }} · {{ c.listName }}</span>
                    </span>
                  </button>
                }
              }

              @if (attachments().length) {
                <div class="group-label"><i class="ti ti-paperclip"></i> Attachments</div>
                @for (a of attachments(); track a.id; let i = $index) {
                  <button
                    [id]="resultId(attachmentsOffset() + i)"
                    type="button"
                    class="row"
                    role="option"
                    [class.active]="highlightedIndex() === attachmentsOffset() + i"
                    [attr.aria-selected]="highlightedIndex() === attachmentsOffset() + i"
                    (mouseenter)="highlightedIndex.set(attachmentsOffset() + i)"
                    (click)="select({ kind: 'attachment', data: a })"
                  >
                    <span class="row-icon">
                      <i [class]="'ti ti-' + (a.boardIcon || 'layout-kanban')"
                         [style.color]="a.boardColor ? 'var(--color-' + a.boardColor + ')' : null"></i>
                    </span>
                    <span class="row-main">
                      <span class="row-title">{{ a.fileName }}</span>
                      <span class="snippet" [innerHTML]="a.snippet"></span>
                      <span class="meta">{{ a.boardName }} · {{ a.cardTitle }}</span>
                    </span>
                  </button>
                }
              }
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 12vh 16px 16px;
      animation: fade-in 120ms ease;
    }

    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
      width: 100%;
      max-width: 560px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: slide-in 120ms ease;
    }

    .search-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }

    .search-row > .ti {
      font-size: 18px;
      color: var(--text-muted);
    }

    .search-input {
      flex: 1;
      border: none;
      background: transparent;
      outline: none;
      font-size: 15px;
      color: var(--text);
    }

    .search-input::placeholder { color: var(--text-muted); }

    .esc {
      font-size: 11px;
      color: var(--text-muted);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 1px 6px;
    }

    .spin { animation: spin 0.8s linear infinite; color: var(--text-muted); }

    .results {
      overflow-y: auto;
      padding: 6px;
    }

    .group-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      padding: 10px 12px 4px;
    }

    .row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      width: 100%;
      height: auto;
      min-height: 52px;
      box-sizing: border-box;
      text-align: left;
      background: transparent;
      border: none;
      border-radius: var(--radius);
      padding: 10px 12px;
      cursor: pointer;
      color: inherit;
      font: inherit;
      line-height: normal;
      white-space: normal;
    }

    .row.active { background: var(--surface-hover); }

    .row-icon {
      display: grid;
      place-items: center;
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text-muted);
      margin-top: 1px;
    }

    .row-icon .ti { font-size: 16px; line-height: 1; }

    .row-main {
      display: flex;
      flex-direction: column;
      gap: 3px;
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .row-title {
      display: block;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
      color: var(--text);
      white-space: normal;
      overflow-wrap: anywhere;
    }

    /* The snippet is injected via [innerHTML], so pierce emulated encapsulation
       to style the <mark> tags ts_headline produces. */
    .snippet {
      display: block;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-muted);
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .snippet ::ng-deep mark {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      color: var(--text);
      font-weight: 600;
      border-radius: 2px;
      padding: 0 2px;
    }

    .meta {
      display: block;
      font-size: 11px;
      line-height: 1.4;
      color: var(--text-muted);
      opacity: 0.6;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 32px 16px;
      color: var(--text-muted);
      font-size: 13px;
    }

    .empty .ti { font-size: 24px; }

    @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes slide-in { from { opacity: 0; transform: scale(0.98) translateY(-6px) } to { opacity: 1; transform: none } }
    @keyframes spin { to { transform: rotate(360deg) } }
  `,
})
export class GlobalSearchOverlayComponent {
  readonly search = inject(GlobalSearchService);
  private readonly router = inject(Router);

  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>("searchInput");

  readonly cards = computed(() => this.search.results()?.cards ?? []);
  readonly notes = computed(() => this.search.results()?.notes ?? []);
  readonly comments = computed(() => this.search.results()?.comments ?? []);
  readonly attachments = computed(() => this.search.results()?.attachments ?? []);

  readonly hasQuery = computed(() => this.search.query().trim().length > 0);

  // Group offsets into the flattened list used for keyboard navigation.
  readonly notesOffset = computed(() => this.cards().length);
  readonly commentsOffset = computed(() => this.cards().length + this.notes().length);
  readonly attachmentsOffset = computed(
    () => this.cards().length + this.notes().length + this.comments().length,
  );

  readonly flat = computed<FlatResult[]>(() => [
    ...this.cards().map((data): FlatResult => ({ kind: "card", data })),
    ...this.notes().map((data): FlatResult => ({ kind: "note", data })),
    ...this.comments().map((data): FlatResult => ({ kind: "comment", data })),
    ...this.attachments().map((data): FlatResult => ({ kind: "attachment", data })),
  ]);

  readonly highlightedIndex = signal(0);
  readonly highlightedResultId = computed(() => this.flat().length ? this.resultId(this.highlightedIndex()) : null);

  constructor() {
    // Focus the input as soon as the overlay opens and the input renders.
    effect(() => {
      const el = this.inputEl()?.nativeElement;
      if (this.search.isOpen() && el) el.focus();
    });
    // Reset the highlight to the first result whenever the result set changes.
    effect(() => {
      this.search.results();
      this.highlightedIndex.set(0);
    });
  }

  onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.search.close();
      return;
    }
    const count = this.flat().length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count) this.highlightedIndex.set((this.highlightedIndex() + 1) % count);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count) this.highlightedIndex.set((this.highlightedIndex() - 1 + count) % count);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = this.flat()[this.highlightedIndex()];
      if (item) this.select(item);
    }
  }

  resultId(index: number): string {
    return `global-search-result-${index}`;
  }

  select(item: FlatResult) {
    if (item.kind === "note") {
      const note = item.data;
      if (note.boardId) {
        void this.router.navigate(["/b", note.boardId], { queryParams: { view: "notes", noteId: note.id } });
      } else {
        void this.router.navigate(["/w", note.workspaceId, "notes"], { queryParams: { noteId: note.id } });
      }
    } else {
      // Cards, comments and attachments all open the parent card on its board.
      void this.router.navigate(["/b", item.data.boardId], { queryParams: { cardId: item.data.cardId } });
    }
    this.search.close();
  }
}
