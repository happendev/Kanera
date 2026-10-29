import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from "@angular/core";
import type { CardGitHubPullRow, CardGitHubPullsResponse } from "@kanera/shared/dto";
import { SERVER_EVENTS, type ServerToClientEvents } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { registerSocketHandlers } from "../../core/realtime/socket-handlers";
import { SocketService } from "../../core/realtime/socket.service";
import { githubStateLabel } from "./github-state-label";

const STATE_ICONS: Record<CardGitHubPullRow["state"], string> = {
  draft: "git-pull-request-draft",
  open: "git-pull-request",
  merged: "git-merge",
  closed: "git-pull-request-closed",
};

/**
 * Card detail's Pull requests section: GitHub pull requests whose branch, title or body named
 * this card's key, recorded from the GitHub App's webhooks. Hidden until a card has one.
 *
 * Every link or state change also writes a card activity row, so the section re-reads when one of
 * those arrives instead of needing a realtime event of its own.
 */
@Component({
  selector: "k-card-github-pulls",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pulls().length) {
    <section class="detail-section">
      <div class="section-label">
        <i class="ti ti-brand-github" aria-hidden="true"></i>
        &ngsp;<ng-container i18n="Card detail section heading: GitHub pull requests that mention this card">Pull requests</ng-container>
        <span class="count">{{ pulls().length }}</span>
      </div>
      <ul class="gp-list">
        @for (pull of pulls(); track pull.id) {
        <li class="gp-row">
          <a class="gp-link" [href]="pull.url" target="_blank" rel="noopener noreferrer">
            <i class="gp-icon ti" [class]="'ti-' + stateIcon(pull)" [attr.data-state]="pull.state" aria-hidden="true"></i>
            <span class="gp-text">
              <span class="gp-title">{{ pull.title }}</span>
              <span class="gp-meta">{{ pull.repoFullName }}#{{ pull.number }}
                @if (pull.additions !== null && pull.deletions !== null) {
                · <span class="gp-additions">+{{ pull.additions }}</span> <span class="gp-deletions">−{{ pull.deletions }}</span>
                }
              </span>
            </span>
            <span class="gp-state" [attr.data-state]="pull.state">{{ stateLabel(pull) }}</span>
          </a>
        </li>
        }
      </ul>
    </section>
    }
  `,
  styles: [`
    /* Section chrome mirrors card-detail's (its styles are encapsulated), as card-relations does. */
    :host { display: block; flex: none; min-width: 0; }
    .detail-section { --section-content-indent: 21px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
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
    .count {
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
    .gp-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .gp-row { flex: none; border-radius: var(--radius-sm); }
    .gp-row:hover { background: var(--surface-2); }
    .gp-link { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 7px 8px 7px 10px; color: var(--text); text-decoration: none; }
    .gp-icon { flex: none; font-size: var(--text-lg); color: var(--muted); }
    .gp-icon[data-state="open"] { color: var(--success); }
    .gp-icon[data-state="merged"] { color: var(--accent); }
    .gp-icon[data-state="closed"] { color: var(--danger); }
    .gp-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .gp-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-md); }
    .gp-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); font-size: var(--text-sm); }
    .gp-additions { color: var(--success); }
    .gp-deletions { color: var(--danger); }
    .gp-state {
      flex: none;
      padding: 1px 8px;
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--text-muted);
      font-size: var(--text-xs);
      font-weight: 600;
    }
    .gp-state[data-state="open"] { background: var(--success-soft); color: var(--success); }
    .gp-state[data-state="merged"] { background: var(--accent-soft); color: var(--accent); }
    .gp-state[data-state="closed"] { background: var(--danger-soft); color: var(--danger); }
    @media (max-width: 767.98px) {
      .detail-section { --section-content-indent: 0; }
    }
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .gp-link { min-height: 44px; }
    }
  `],
})
export class CardGitHubPullsComponent {
  private readonly api = inject(ApiClient);
  private readonly sockets = inject(SocketService);

  readonly cardId = input.required<string>();
  readonly pulls = signal<CardGitHubPullRow[]>([]);
  private loadSeq = 0;

  constructor() {
    effect((onCleanup) => {
      const cardId = this.cardId();
      void this.sockets.displayedOnline();
      // Clear on every card change so the previous card's pull requests never show under this one.
      untracked(() => {
        this.pulls.set([]);
        this.refresh(cardId);
      });

      const handlers: Partial<ServerToClientEvents> = {
        [SERVER_EVENTS.CARD_FEED_ITEM_CREATED]: ({ cardId: changedCardId, item }) => {
          if (changedCardId === cardId && item.type === "activity" && item.data.action.startsWith("githubPull:")) this.refresh(cardId);
        },
      };
      onCleanup(registerSocketHandlers(this.sockets.connect(), handlers));
    });
  }

  stateIcon(pull: CardGitHubPullRow): string {
    return STATE_ICONS[pull.state];
  }

  stateLabel(pull: CardGitHubPullRow): string {
    return githubStateLabel(pull.state);
  }

  private refresh(cardId: string) {
    const seq = ++this.loadSeq;
    if (!this.sockets.displayedOnline()) return;
    void this.api.get<CardGitHubPullsResponse>(`/cards/${cardId}/github-pulls`)
      .then(({ pulls }) => { if (seq === this.loadSeq) this.pulls.set(pulls); })
      .catch(() => undefined);
  }
}
