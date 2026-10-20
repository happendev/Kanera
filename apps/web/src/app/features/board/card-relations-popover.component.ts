import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output, signal } from "@angular/core";
import { Router } from "@angular/router";
import { cardPath } from "@kanera/shared/card-links";
import type { CardRelationCard, CardRelationsResponse, CardRelationSummary } from "@kanera/shared/dto";
import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { SocketService } from "../../core/realtime/socket.service";
import { ApiClient } from "../../core/api/api.client";
import { ANCHORED_HOST_STYLES, type AnchoredPanelPlacement } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { CardRelationsComponent } from "./card-relations.component";

/**
 * Dependencies from a card's right-click menu, on the board and in the table, without opening card
 * detail. It reads the relations itself (the board holds no card detail for a closed card) and
 * re-reads after each change; tiles converge on the realtime `card:updated` echo.
 */
@Component({
  selector: "k-card-relations-popover",
  standalone: true,
  imports: [CardRelationsComponent],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Contained like the reminder popover: typing in the search must not drive the menu's
         type-to-select, and clicks must not reach the tile underneath. Escape still bubbles. -->
    <div class="crp-panel" role="dialog" aria-label="Dependencies" i18n-aria-label
      (keydown)="$event.key === 'Escape' || $event.stopPropagation()" (click)="$event.stopPropagation()">
      @if (loaded()) {
      <k-card-relations [cardId]="cardId()" [workspaceId]="workspaceId()" [relations]="relations()" [hiddenBlockerCount]="hiddenBlockerCount()"
        [canEdit]="canEdit()" [canEditRole]="canEdit()" [popover]="true"
        (changed)="load()" (openCard)="openCard($event)" />
      } @else if (loadFailed()) {
      <p class="crp-loading crp-error" role="alert">
        <ng-container i18n="Error shown when the dependencies popover could not load a card's relations">Couldn't load dependencies.</ng-container>
        &ngsp;<button type="button" class="crp-retry" (click)="load()" i18n="Button: retry loading the dependencies popover">Try again</button>
      </p>
      } @else {
      <p class="crp-loading" i18n="Loading state in the dependencies popover">Loading dependencies…</p>
      }
    </div>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .crp-panel {
      width: 100%;
      max-height: var(--ap-max-height, 520px);
      overflow-y: auto;
      overscroll-behavior: contain;
      box-sizing: border-box;
      padding: 10px 12px;
      background: var(--surface-overlay);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
    }
    /* No left indent inside the narrow popover; the section heading is the popover's title. */
    k-card-relations { --cr-indent: 0; }
    .crp-loading { margin: 6px 0; color: var(--muted); font-size: var(--text-base); }
    .crp-error { color: var(--danger); }
    .crp-retry {
      height: auto;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      font-size: var(--text-base);
      font-weight: 500;
      text-decoration: underline;
    }
    .crp-retry:hover:not(:disabled) { background: transparent; color: var(--text); }
    `,
  ],
})
export class CardRelationsPopoverComponent implements OnInit {
  private readonly panel = inject(AnchoredPanelDirective);
  private readonly api = inject(ApiClient);
  private readonly sockets = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  readonly cardId = input.required<string>();
  readonly workspaceId = input<string | null>(null);
  readonly canEdit = input(true);
  /** Desktop placement override, e.g. beside the context-menu row. */
  readonly panelPlacement = input<AnchoredPanelPlacement | null>(null);
  readonly dismissed = output<void>();

  readonly loaded = signal(false);
  /** The read failed and nothing is shown yet; a retry replaces this with the list or the same error. */
  readonly loadFailed = signal(false);
  readonly relations = signal<CardRelationSummary[]>([]);
  readonly hiddenBlockerCount = signal(0);
  private loadSeq = 0;

  constructor() {
    this.panel.configure({
      placement: () => {
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        const phone = viewportWidth <= 560;
        return {
          align: "end",
          ...(phone ? {} : this.panelPlacement()),
          // Wide enough for a row's title, labels and assignee avatars side by side.
          width: phone ? Math.round(viewportWidth - 16) : 460,
          margin: phone ? 8 : 12,
          maxHeight: 520,
          minHeight: 240,
        };
      },
      onDismiss: () => this.dismissed.emit(),
    });
  }

  ngOnInit(): void {
    this.load();
    const socket = this.sockets.connect();
    const links: ServerToClientEvents[typeof SERVER_EVENTS.CARD_LINKS_CHANGED] = ({ cardId }) => {
      if (cardId === this.cardId()) this.load();
    };
    socket.on(SERVER_EVENTS.CARD_LINKS_CHANGED, links);
    this.destroyRef.onDestroy(() => {
      socket.off(SERVER_EVENTS.CARD_LINKS_CHANGED, links);
      this.loadSeq++;
    });
  }

  load() {
    const seq = ++this.loadSeq;
    this.loadFailed.set(false);
    void this.api.get<CardRelationsResponse>(`/cards/${this.cardId()}/relations`)
      .then((response) => {
        if (seq !== this.loadSeq) return;
        this.relations.set(response.relations);
        this.hiddenBlockerCount.set(response.hiddenBlockerCount);
        this.loaded.set(true);
      })
      .catch(() => {
        // A re-read after a change keeps the list it has; only a first load with nothing to show
        // reports the failure, so the editor never opens empty and pretends there are no relations.
        if (seq === this.loadSeq && !this.loaded()) this.loadFailed.set(true);
      });
  }

  openCard(card: CardRelationCard) {
    void this.router.navigate(["/b", card.boardId, "c", card.id], { browserUrl: cardPath(card.organisationKey, card.key) });
    this.dismissed.emit();
  }
}
