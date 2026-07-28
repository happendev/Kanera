import type { OnInit } from "@angular/core";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { WorkCatalogBoard, WorkCatalogList } from "@kanera/shared/dto";
import {
  ANCHORED_PANEL_STYLES,
  ANCHORED_SHEET_STYLES,
  PANEL_INPUT_STYLES,
} from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AutofocusDirective } from "../../shared/autofocus.directive";
import { PickerListComponent } from "../../shared/picker-list.component";
import { GlobalWorkState } from "./global-work.state";
import { boardPickerGroups, listPickerGroups } from "./work-pickers";

/**
 * Card creation for the global work pages, as a popover anchored to the "Create card" button.
 *
 * Board and list selection drill down inside the same panel (rather than nesting popovers) so the
 * picker never opens a second floating layer that could land off-screen, and so the flow works the
 * same when the panel is docked as a bottom sheet on a phone.
 */
@Component({
  selector: "k-global-card-create",
  standalone: true,
  imports: [AutofocusDirective, PickerListComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ap-panel">
      @switch (view()) {
        @case ("board") {
          <div class="ap-head">
            <button type="button" class="ap-icon-button" aria-label="Back" (click)="view.set('form')">
              <i class="ti ti-chevron-left"></i>
            </button>
            <span class="ap-title">Board</span>
          </div>
          <k-picker-list
            [groups]="boardGroups()"
            [selectedIds]="boardId() ? [boardId()] : []"
            searchPlaceholder="Search boards…"
            emptyLabel="No boards you can add cards to"
            (pick)="selectBoard($event)"
          />
        }

        @case ("list") {
          <div class="ap-head">
            <button type="button" class="ap-icon-button" aria-label="Back" (click)="view.set('form')">
              <i class="ti ti-chevron-left"></i>
            </button>
            <span class="ap-title">List</span>
          </div>
          <k-picker-list
            [groups]="listGroups()"
            [selectedIds]="listId() ? [listId()] : []"
            searchPlaceholder="Search lists…"
            emptyLabel="This workspace has no lists"
            (pick)="selectList($event)"
          />
        }

        @default {
          <div class="ap-head">
            <span class="ap-title">Create card</span>
            <button type="button" class="ap-icon-button" aria-label="Close" (click)="closed.emit()">
              <i class="ti ti-x"></i>
            </button>
          </div>

          <form class="cc-form" (submit)="submit($event)">
            <label class="cc-field">
              <span class="cc-label">Card title</span>
              <input
                autofocus
                class="ap-input"
                [value]="title()"
                (input)="title.set($any($event.target).value)"
                maxlength="500"
                placeholder="What needs doing?"
              />
            </label>

            <div class="cc-field">
              <span class="cc-label">Board</span>
              <button type="button" class="cc-trigger" (click)="view.set('board')">
                <i
                  class="ti ti-{{ selectedBoard()?.icon || 'layout-kanban' }}"
                  [style.color]="colorToken(selectedBoard()?.iconColor)"
                ></i>
                <span class="cc-trigger-text">
                  <strong>{{ selectedBoard()?.name ?? "Choose a board" }}</strong>
                  @if (selectedBoard()) { <small>{{ workspaceName(selectedBoard()!.workspaceId) }}</small> }
                </span>
                <i class="ti ti-selector cc-trigger-caret"></i>
              </button>
            </div>

            <div class="cc-field">
              <span class="cc-label">List</span>
              <button type="button" class="cc-trigger" [disabled]="!boardId()" (click)="view.set('list')">
                <i
                  class="ti ti-{{ selectedList()?.icon || 'list' }}"
                  [style.color]="colorToken(selectedList()?.color)"
                ></i>
                <span class="cc-trigger-text">
                  <strong>{{ selectedList()?.name ?? "Choose a list" }}</strong>
                </span>
                <i class="ti ti-selector cc-trigger-caret"></i>
              </button>
            </div>

            <p class="cc-target">
              <i class="ti ti-user-check"></i>
              Assigned to {{ targetName() }}
            </p>

            @if (error()) {
              <p class="cc-error" role="alert">{{ error() }}</p>
            }

            <footer class="cc-actions">
              <button type="button" class="cc-cancel" (click)="closed.emit()">Cancel</button>
              <button type="submit" class="cc-submit" [disabled]="!canSubmit()">
                {{ busy() ? "Creating…" : "Create card" }}
              </button>
            </footer>
          </form>
        }
      }
    </div>
  `,
  styles: [
    ANCHORED_PANEL_STYLES,
    ANCHORED_SHEET_STYLES,
    PANEL_INPUT_STYLES,
    `
      .cc-form {
        display: grid;
        gap: 12px;
        overflow-y: auto;
      }

      .cc-field {
        display: grid;
        gap: 5px;
        min-width: 0;
      }

      .cc-label {
        color: var(--text-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      /* Opt out of the global button reset (fixed 36px, centred content) so the trigger reads as a
         select: left-aligned icon + value, trailing caret, and room for a second line of context. */
      .cc-trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        height: auto;
        min-height: 34px;
        padding: 6px 9px;
        color: var(--text);
        text-align: left;
        white-space: normal;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-size: 13px;
        cursor: pointer;

        &:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--border-strong); }
        &:disabled { opacity: 0.55; cursor: not-allowed; }

        > i:first-child { flex: none; font-size: 16px; color: var(--text-muted); }
      }

      .cc-trigger-text {
        display: grid;
        flex: 1;
        min-width: 0;

        strong,
        small {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        strong { font-weight: 500; }
        small { color: var(--text-muted); font-size: 11px; }
      }

      .cc-trigger-caret { flex: none; color: var(--text-muted); font-size: 15px; }

      .cc-target {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        color: var(--text-muted);
        font-size: 12px;
      }

      .cc-error {
        margin: 0;
        color: var(--danger);
        font-size: 12px;
      }

      .cc-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 2px;
      }

      /* Only compact panel sizing is set here. .cc-submit deliberately keeps the global
         primary button colours (accent fill + hover + focus ring) so it matches every
         other primary action in the app; overriding just the background would leave the
         global button:hover rule — which out-specifies a single class — to flip it to
         accent on hover. */
      .cc-cancel,
      .cc-submit {
        height: 32px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }

      .cc-cancel {
        color: var(--text-muted);
        background: transparent;
        border: 1px solid var(--border);

        &:hover { color: var(--text); background: var(--surface-2); }
      }
    `,
  ],
})
export class GlobalCardCreatePopover implements OnInit {
  private readonly panel = inject(AnchoredPanelDirective);
  // Provided by GlobalWorkPage, so the popover shares the page's catalog and create path.
  private readonly state = inject(GlobalWorkState);

  constructor() {
    this.panel.configure({
      placement: () => ({ align: "end", width: 340, maxHeight: 460 }),
      // Escape inside a drill-down step goes back to the form; an outside click closes the popover.
      onDismiss: (reason) => {
        if (reason === "escape" && this.view() !== "form") this.view.set("form");
        else this.closed.emit();
      },
    });
  }

  /** Boards the target user can be assigned work on. */
  readonly boards = input.required<WorkCatalogBoard[]>();
  readonly targetUserId = input.required<string>();
  readonly targetName = input.required<string>();

  readonly created = output<void>();
  readonly closed = output<void>();

  readonly view = signal<"form" | "board" | "list">("form");
  readonly title = signal("");
  readonly boardId = signal("");
  readonly listId = signal("");
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly boardGroups = computed(() => boardPickerGroups(this.state.catalog(), this.boards()));
  readonly selectedBoard = computed(() => this.boards().find((board) => board.id === this.boardId()) ?? null);
  readonly lists = computed<WorkCatalogList[]>(() => {
    const board = this.selectedBoard();
    // Lists are workspace-scoped, so a board's lanes are its workspace's lists.
    return board ? this.state.catalog().lists.filter((list) => list.workspaceId === board.workspaceId) : [];
  });
  readonly listGroups = computed(() => listPickerGroups(this.lists()));
  readonly selectedList = computed(() => this.lists().find((list) => list.id === this.listId()) ?? null);
  readonly canSubmit = computed(() =>
    Boolean(this.title().trim() && this.boardId() && this.listId())
    && !this.busy()
    && this.state.interactionReady()
  );

  ngOnInit(): void {
    // Default to the first available board so the common case is one title away from done.
    const first = this.boards()[0];
    if (first) this.applyBoard(first.id);
  }

  selectBoard(boardId: string): void {
    this.applyBoard(boardId);
    this.view.set("form");
  }

  selectList(listId: string): void {
    this.listId.set(listId);
    this.view.set("form");
  }

  private applyBoard(boardId: string): void {
    this.boardId.set(boardId);
    this.listId.set(this.lists()[0]?.id ?? "");
  }

  colorToken(color: string | null | undefined): string | null {
    return color ? `var(--color-${color})` : null;
  }

  workspaceName(workspaceId: string): string {
    return this.state.catalog().workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Workspace";
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.state.createCard(this.boardId(), this.listId(), this.title(), [this.targetUserId()]);
      this.created.emit();
    } catch {
      this.error.set("We couldn’t create the card. Please try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
