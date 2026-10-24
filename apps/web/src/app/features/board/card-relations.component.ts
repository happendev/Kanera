import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from "@angular/core";
import { cardPath } from "@kanera/shared/card-links";
import type { CardRelationDirection } from "@kanera/shared/card-relations";
import type { CardRelationCard, CardRelationSummary, CardSearchResult, WireSearchResults } from "@kanera/shared/dto";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AvatarComponent } from "../../shared/avatar.component";
import { SegmentedComponent, type SegmentedOption } from "../../shared/segmented.component";
import { ToastService } from "../../shared/toast.service";
import { TooltipDirective } from "../../shared/tooltip.directive";
import { CardLabelsComponent } from "./card-labels.component";
import { isPlainPrimaryClick } from "./card-navigation.util";
import { BoardState } from "./board-state";
import { blockerStatus, hiddenBlockersLabel } from "./card-relations.util";

const SEARCH_DEBOUNCE_MS = 200;

/**
 * Card detail's Dependencies section: what blocks this card, what it blocks, and related cards.
 *
 * The parent owns the data (board state's card detail) and re-reads it on `card:links:changed`;
 * this component only renders it and makes the add/remove calls. Rows for cards the viewer cannot
 * open never arrive, so a hidden blocker shows only as a count.
 */
@Component({
  selector: "k-card-relations",
  standalone: true,
  imports: [AvatarComponent, CardLabelsComponent, SegmentedComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (popover() || groups().length || hiddenBlockerCount() || canEditRole()) {
    <section class="detail-section" [class.is-popover]="popover()">
      <div class="section-label">
        <i class="ti ti-git-merge" aria-hidden="true"></i>
        &ngsp;<ng-container i18n="Card detail section heading: cards this card blocks, is blocked by, or relates to">Dependencies</ng-container>
        @if (relations().length) {
        <span class="count">{{ relations().length }}</span>
        }
        @if (!popover() && canEditRole() && !adding()) {
        <button #addButton type="button" class="cr-add-btn" [disabled]="!canEdit()" (click)="startAddingNow()">
          <i class="ti ti-plus" aria-hidden="true"></i>
          &ngsp;<ng-container i18n="Button: relate this card to another card">Add</ng-container>
        </button>
        }
      </div>

      <div class="cr-body">
        @if (adding()) {
        <div class="cr-add">
          @if (directionOptions().length > 1) {
          <k-segmented [options]="directionOptions()" [value]="direction()" [showLabels]="true" [equalWidths]="true" size="sm"
            ariaLabel="Relation type" i18n-ariaLabel (valueChange)="changeDirection($event)" />
          }
          <div class="cr-search">
            <i class="ti ti-search" aria-hidden="true"></i>
            <input #searchInput class="cr-search-input" type="search" autocomplete="off"
              placeholder="Search cards by title or key" i18n-placeholder
              aria-label="Search cards by title or key" i18n-aria-label
              [value]="query()" (input)="onQuery($any($event.target).value)" (keydown.escape)="popover() || cancelAdding()" />
            @if (!popover()) {
            <button type="button" class="cr-icon-btn" aria-label="Cancel" i18n-aria-label kTooltip="Cancel" i18n-kTooltip (click)="cancelAdding()">
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
            }
          </div>
          @if (results().length) {
          <div class="cr-results" role="listbox" aria-label="Matching cards" i18n-aria-label>
            @for (result of results(); track result.cardId) {
            <button type="button" class="cr-result" role="option" [disabled]="saving()" (click)="add(result)">
              <span class="cr-row-text">
                <span class="cr-title">{{ result.cardTitle }}</span>
                <span class="cr-meta"><span class="cr-key">{{ result.cardKey }}</span> · {{ result.boardName }} › {{ result.listName }}</span>
              </span>
              <i class="ti ti-plus cr-result-add" aria-hidden="true"></i>
            </button>
            }
          </div>
          } @else if (searchFailed()) {
          <p class="cr-empty cr-error" role="alert" i18n="Error shown when the dependency card search request failed">Couldn't search cards. Check your connection and try again.</p>
          } @else if (searched() && query().trim()) {
          <p class="cr-empty" i18n="Empty state when no card matches the dependency search">No matching cards in this workspace</p>
          }
        </div>
        }

        @if (blockerStatus(); as status) {
        <!-- A statement about this card, not a control: no box or fill, so it doesn't read as a button. -->
        <p class="cr-status" [class.is-blocked]="status.blocked" role="status">
          <i class="ti" [class.ti-lock]="status.blocked" [class.ti-lock-open]="!status.blocked" aria-hidden="true"></i>
          <span class="cr-status-text">
            <span class="cr-status-title">{{ status.title }}</span>
            @if (hiddenBlockerCount(); as hidden) {
            <span class="cr-status-note">{{ hiddenBlockerLabel(hidden) }}</span>
            }
          </span>
        </p>
        } @else if (hiddenBlockerCount(); as hidden) {
        <!-- The host shows the status line above, but the hidden-blocker note still needs a visible
             home here: on a phone there is no tooltip, and this section would otherwise be empty. -->
        <p class="cr-status is-blocked" role="status">
          <i class="ti ti-lock" aria-hidden="true"></i>
          <span class="cr-status-text"><span class="cr-status-note">{{ hiddenBlockerLabel(hidden) }}</span></span>
        </p>
        }

        @for (group of groups(); track group.direction) {
        <div class="cr-group">
          <div class="cr-group-label">
            <i class="ti" [class]="'ti ' + group.icon + (group.tone ? ' is-' + group.tone : '')" aria-hidden="true"></i>
            <span>{{ group.label }}</span>
            <span class="cr-group-count">{{ group.relations.length }}</span>
          </div>
          <ul class="cr-list">
            @for (relation of group.relations; track relation.id) {
            <li class="cr-row" [class.is-closed]="isClosed(relation.card)">
              <a class="cr-link" [href]="href(relation.card)" (click)="onOpen($event, relation.card)">
                <i class="ti cr-state" [class.ti-circle-check]="relation.card.completedAt" [class.ti-archive]="!relation.card.completedAt && relation.card.archivedAt"
                  [class.ti-circle-dashed]="!isClosed(relation.card)" aria-hidden="true"></i>
                <span class="cr-row-text">
                  <span class="cr-title">{{ relation.card.title }}</span>
                  <span class="cr-meta"><span class="cr-key">{{ relation.card.key }}</span> · {{ relation.card.boardName }} › {{ relation.card.listName }}</span>
                  @if (relation.card.labels.length) {
                  <!-- Presentational inside the link: no nested buttons, and names stay readable. -->
                  <k-card-labels class="cr-labels" [labels]="relation.card.labels" [interactive]="false" [alwaysExpanded]="true" [limit]="3" [showOverflow]="true" />
                  }
                </span>
                @if (relation.card.assignees.length) {
                <!-- Who owns the other card, the tile's avatar stack. Tooltips only: a profile popover
                     would nest a control inside the link. -->
                <span class="cr-assignees">
                  @for (assignee of relation.card.assignees.slice(0, 3); track assignee.userId) {
                  <k-avatar class="cr-avatar" [url]="assignee.avatarUrl" [name]="assignee.displayName" [size]="22" />
                  }
                  @if (relation.card.assignees.length > 3) {
                  <span class="cr-avatar cr-avatar-overflow" [kTooltip]="overflowNames(relation.card.assignees)">+{{ relation.card.assignees.length - 3 }}</span>
                  }
                </span>
                }
                @if (isClosed(relation.card)) {
                <span class="cr-pill">{{ statusLabel(relation.card) }}</span>
                }
              </a>
              @if (canEditRole()) {
              <button type="button" class="cr-icon-btn cr-remove" [disabled]="!canEdit() || removingId() === relation.id"
                aria-label="Remove relation" i18n-aria-label kTooltip="Remove relation" i18n-kTooltip (click)="remove(relation)">
                <i class="ti ti-x" aria-hidden="true"></i>
              </button>
              }
            </li>
            }
          </ul>
        </div>
        }
      </div>
    </section>
    }
  `,
  styles: [`
    /* Section chrome mirrors card-detail's (its styles are encapsulated), as card-activity does. */
    :host { display: block; flex: none; min-width: 0; }
    .detail-section {
      --section-content-indent: var(--cr-indent, 21px);
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }
    .detail-section > :not(.section-label) { margin-left: var(--section-content-indent); }
    .section-label {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 28px;
      font-size: var(--text-base);
      font-weight: 600;
      color: var(--text-muted);
    }
    .section-label i { font-size: var(--text-md); }
    .count, .cr-group-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 6px;
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--text-muted);
      font-size: var(--text-xs);
      font-weight: 600;
    }
    .cr-add-btn {
      margin-left: auto;
      height: var(--h-sm);
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface);
      color: var(--text);
      font-size: var(--text-sm);
      font-weight: 500;
      gap: 4px;
    }
    .cr-add-btn:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
    .cr-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

    /* Add */
    .cr-add { display: grid; gap: 8px; }
    .cr-search {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 4px 0 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface);
    }
    .cr-search:focus-within { border-color: var(--accent); }
    .cr-search > i { color: var(--muted); font-size: var(--text-md); }
    .cr-search input.cr-search-input {
      flex: 1;
      min-width: 0;
      height: 34px;
      border: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
      outline: none;
    }
    .cr-results {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }
    button.cr-result {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      height: auto;
      min-height: 44px;
      padding: 6px 10px;
      border: 0;
      border-radius: 0;
      background: var(--surface);
      color: var(--text);
      text-align: left;
      font-weight: 400;
    }
    button.cr-result + button.cr-result { border-top: 1px solid var(--border); }
    button.cr-result:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
    .cr-result-add { margin-left: auto; color: var(--muted); font-size: var(--text-md); }

    /* Status line: answers "can I start this?" before any list. Plain text with a coloured icon. */
    .cr-status {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      margin: 0;
      color: var(--text);
      font-size: var(--text-base);
    }
    .cr-status > i { font-size: 15px; margin-top: 1px; color: var(--success, var(--color-green)); }
    .cr-status.is-blocked > i { color: var(--danger); }
    .cr-status-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cr-status-title { font-weight: 500; }
    .cr-status-note { color: var(--text-muted); font-size: var(--text-sm); }

    /* Groups: one bordered list per direction, rows divided rather than boxed. */
    .cr-group { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .cr-group-label {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text-muted);
      font-size: var(--text-sm);
      font-weight: 600;
    }
    .cr-group-label i { font-size: var(--text-base); }
    /* Same hues as card detail's dependency chips; only the icon is tinted so the headings stay calm. */
    .cr-group-label i.is-danger { color: var(--danger); }
    .cr-group-label i.is-warning { color: var(--color-amber); }
    .cr-list {
      list-style: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: var(--surface);
    }
    .cr-row { display: flex; align-items: center; min-width: 0; }
    .cr-row + .cr-row { border-top: 1px solid var(--border); }
    .cr-row:hover { background: var(--surface-2); }
    .cr-link {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
      padding: 7px 4px 7px 10px;
      color: var(--text);
      text-decoration: none;
    }
    .cr-state { flex: none; font-size: var(--text-lg); color: var(--muted); }
    .cr-row.is-closed .cr-state.ti-circle-check { color: var(--success, var(--accent)); }
    .cr-row-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
    .cr-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-md); }
    .cr-row.is-closed .cr-title { color: var(--text-muted); text-decoration: line-through; }
    .cr-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--text-sm); }
    .cr-key { font-variant-numeric: tabular-nums; }
    .cr-labels { margin-top: 3px; --label-bar-gap: 0; --label-chip-height: 18px; --label-chip-font-size: var(--text-xs); --label-chip-max-width: 140px; }
    .cr-assignees { display: flex; flex: none; align-items: center; }
    .cr-avatar {
      width: 22px;
      height: 22px;
      margin-left: -6px;
      border: 2px solid var(--surface);
      border-radius: 50%;
      box-sizing: content-box;
    }
    .cr-avatar:first-child { margin-left: 0; }
    .cr-row:hover .cr-avatar { border-color: var(--surface-2); }
    .cr-avatar-overflow {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--surface-hover, var(--surface-2));
      color: var(--text-muted);
      font-size: 10px;
      font-weight: 600;
    }
    .cr-pill {
      flex: none;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--text-muted);
      font-size: var(--text-xs);
      font-weight: 600;
    }
    .cr-icon-btn {
      flex: none;
      width: 30px;
      height: var(--h-md);
      margin-right: 4px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--muted);
    }
    .cr-icon-btn:hover:not(:disabled) { background: var(--surface-3, var(--border)); color: var(--text); }
    /* Remove appears on row hover or focus on desktop; always visible for touch (no hover). */
    .cr-remove { opacity: 0; }
    .cr-row:hover .cr-remove, .cr-remove:focus-visible { opacity: 1; }
    .cr-empty { margin: 0; color: var(--muted); font-size: var(--text-base); }
    .cr-error { color: var(--danger); }
    .is-popover .cr-add { order: 0; }
    @media (max-width: 767.98px) {
      .detail-section { --section-content-indent: 0; }
    }
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .cr-remove { opacity: 1; }
      .cr-icon-btn { width: 44px; height: 44px; }
      .cr-link { min-height: 44px; }
      .cr-add-btn { height: 36px; }
    }
  `],
})
export class CardRelationsComponent implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly toasts = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly cardId = input.required<string>();
  /** Narrows search hits to the card's workspace; null when the host does not know it (the API still refuses other workspaces). */
  readonly workspaceId = input<string | null>(null);
  /**
   * The right-click popover: the search is always open (it is what the menu item is for), there is no
   * Add/Cancel, and it stays open after each add so several can be set in a row.
   */
  readonly popover = input(false);
  readonly relations = input<CardRelationSummary[]>([]);
  readonly hiddenBlockerCount = input(0);
  /** The host already shows the blocker status line (and the hidden-blocker note) elsewhere; skip it here. */
  readonly statusShownAbove = input(false);
  /** This card is completed or archived, so it no longer holds up the cards it blocks. */
  readonly cardClosed = input(false);
  readonly canEdit = input(false);
  readonly canEditRole = input(false);
  /** A relation was added or removed here; the parent re-reads (the realtime echo would also do it). */
  readonly changed = output<void>();
  /** A plain click on a related card; the parent routes the drawer to it. */
  readonly openCard = output<CardRelationCard>();

  /**
   * The workspace has dependencies switched off: only plain "Relates to" links can be added (the
   * server hides `blocks` relations and refuses new ones). Outside a board there is no BoardState,
   * and the server's refusal stays the guard.
   */
  private readonly boardState = inject(BoardState, { optional: true });
  readonly dependenciesEnabled = computed(() => this.boardState?.dependenciesEnabled() ?? true);
  readonly adding = signal(false);
  private readonly chosenDirection = signal<CardRelationDirection>("blocked_by");
  readonly direction = computed<CardRelationDirection>(() => this.dependenciesEnabled() ? this.chosenDirection() : "relates_to");
  readonly query = signal("");
  readonly results = signal<CardSearchResult[]>([]);
  readonly searched = signal(false);
  /** The last search request failed; distinct from "no matches" so offline users are not misled. */
  readonly searchFailed = signal(false);
  readonly saving = signal(false);
  readonly removingId = signal<string | null>(null);
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>("searchInput");
  private readonly addButton = viewChild<ElementRef<HTMLButtonElement>>("addButton");
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;

  private readonly allDirectionOptions: readonly SegmentedOption<CardRelationDirection>[] = [
    { id: "blocked_by", label: $localize`:Relation type choice - the chosen card blocks this card:Blocked by` },
    { id: "blocks", label: $localize`:Relation type choice - this card blocks the chosen card:Blocks` },
    { id: "relates_to", label: $localize`:Relation type choice - the cards are related without an order:Relates to` },
  ];
  readonly directionOptions = computed(() => this.dependenciesEnabled()
    ? this.allDirectionOptions
    : this.allDirectionOptions.filter((option) => option.id === "relates_to"));

  readonly groups = computed(() => {
    const icons: Record<CardRelationDirection, string> = { blocked_by: "ti-lock", blocks: "ti-hand-stop", relates_to: "ti-arrows-left-right" };
    const labels: Record<CardRelationDirection, string> = {
      blocked_by: $localize`:Dependencies group heading - cards that block this one:Blocked by`,
      blocks: $localize`:Dependencies group heading - cards this one blocks:Blocks`,
      relates_to: $localize`:Dependencies group heading - related cards:Related`,
    };
    const order: CardRelationDirection[] = ["blocked_by", "blocks", "relates_to"];
    // Tinted only while the relation still holds work up: red while an active card blocks this one,
    // amber while this open card blocks others. Closed sides and Related stay neutral.
    const tone = (direction: CardRelationDirection, relations: CardRelationSummary[]): "danger" | "warning" | null => {
      if (direction === "blocked_by") return relations.some((relation) => !this.isClosed(relation.card)) ? "danger" : null;
      if (direction === "blocks") return this.cardClosed() ? null : "warning";
      return null;
    };
    return order
      .map((direction) => {
        const relations = this.relations().filter((relation) => relation.direction === direction);
        return { direction, icon: icons[direction], label: labels[direction], relations, tone: tone(direction, relations) };
      })
      .filter((group) => group.relations.length > 0);
  });

  ngOnInit(): void {
    if (this.popover()) this.startAddingNow();
  }

  /** The card detail shows this line in its top status row instead (`statusShownAbove`). */
  readonly blockerStatus = computed(() => (this.statusShownAbove() ? null : blockerStatus(this.relations(), this.hiddenBlockerCount())));

  readonly hiddenBlockerLabel = hiddenBlockersLabel;

  overflowNames(assignees: CardRelationCard["assignees"]): string {
    return assignees.slice(3).map((assignee) => assignee.displayName).join(", ");
  }

  isClosed(card: CardRelationCard): boolean {
    return Boolean(card.completedAt || card.archivedAt);
  }

  /** Only shown for closed cards (`isClosed`), so there is no "Open" label to translate. */
  statusLabel(card: CardRelationCard): string {
    return card.completedAt ? $localize`:Status of a related card:Completed` : $localize`:Status of a related card:Archived`;
  }

  href(card: CardRelationCard): string {
    return cardPath(card.organisationKey, card.key);
  }

  onOpen(event: MouseEvent, card: CardRelationCard) {
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    this.openCard.emit(card);
  }

  startAddingNow() {
    this.adding.set(true);
    // The input renders on the next tick; focus it so typing can start straight away.
    setTimeout(() => this.searchInput()?.nativeElement.focus());
  }

  cancelAdding() {
    this.searchSeq++;
    this.adding.set(false);
    this.query.set("");
    this.results.set([]);
    this.searched.set(false);
    this.searchFailed.set(false);
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  changeDirection(direction: CardRelationDirection) {
    this.chosenDirection.set(direction);
    this.onQuery(this.query());
  }

  onQuery(value: string) {
    this.searchSeq++;
    this.query.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    const q = value.trim();
    this.searchFailed.set(false);
    if (!q) {
      this.results.set([]);
      this.searched.set(false);
      return;
    }
    this.searchTimer = setTimeout(() => void this.search(q), SEARCH_DEBOUNCE_MS);
  }

  private async search(q: string) {
    const seq = ++this.searchSeq;
    try {
      const workspaceId = this.workspaceId();
      const workspaceQuery = workspaceId ? `&workspaceId=${workspaceId}` : "";
      const response = await this.api.get<WireSearchResults>(`/search?q=${encodeURIComponent(q)}&limit=10${workspaceQuery}&relationCardId=${this.cardId()}&relationDirection=${this.direction()}`);
      if (seq !== this.searchSeq) return;
      const existing = new Set(this.relations().filter((relation) => relation.direction === this.direction()).map((relation) => relation.card.id));
      // Relations never cross workspaces, so other workspaces' hits would only fail on add.
      this.results.set(response.cards.filter((card) =>
        (!workspaceId || card.workspaceId === workspaceId) && card.cardId !== this.cardId() && !existing.has(card.cardId)));
      this.searched.set(true);
      this.searchFailed.set(false);
    } catch {
      if (seq === this.searchSeq) {
        this.results.set([]);
        this.searched.set(false);
        this.searchFailed.set(true);
      }
    }
  }

  async add(result: CardSearchResult) {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      await this.api.post(`/cards/${this.cardId()}/relations`, { targetCardId: result.cardId, direction: this.direction() });
      if (this.popover()) {
        // Stay on the search for the next one; the list below picks the new relation up on re-read.
        this.query.set("");
        this.results.set([]);
        this.searched.set(false);
        this.searchInput()?.nativeElement.focus();
      } else {
        this.cancelAdding();
        // The search input unmounts; keyboard users continue from the Add button that opened it.
        setTimeout(() => this.addButton()?.nativeElement.focus());
      }
      this.changed.emit();
    } catch (error) {
      this.toasts.error(errorMessage(error, $localize`Couldn't add the relation. Try again.`));
    } finally {
      this.saving.set(false);
    }
  }

  async remove(relation: CardRelationSummary) {
    this.removingId.set(relation.id);
    try {
      await this.api.delete(`/cards/${this.cardId()}/relations/${relation.id}`);
      this.changed.emit();
      // The row unmounts on re-read; land on the next Remove button, else on Add, not on <body>.
      setTimeout(() => {
        const next = this.host.nativeElement.querySelector<HTMLElement>(".cr-remove:not(:disabled)");
        (next ?? this.addButton()?.nativeElement ?? this.searchInput()?.nativeElement)?.focus();
      });
    } catch (error) {
      this.toasts.error(errorMessage(error, $localize`Couldn't remove the relation. Try again.`));
    } finally {
      this.removingId.set(null);
    }
  }
}

/** The API's own message (already in the viewer's language, e.g. the cycle rejection), else a fallback. */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const message = (error.body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}
