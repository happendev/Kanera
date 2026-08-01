import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import { Router } from "@angular/router";
import { cardPath } from "@kanera/shared/card-links";
import { ApiClient } from "../../core/api/api.client";

interface ResolvedCardKey {
  id: string;
  boardId: string;
  organisationKey: string;
  key: string;
}

@Component({
  selector: "k-card-key-redirect-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="key-resolver" aria-live="polite">
      @if (failed()) {
        <i class="ti ti-file-unknown"></i>
        <h1>Card not found</h1>
        <p>The card may not exist, or you may not have access to it.</p>
      } @else {
        <i class="ti ti-loader-2 spin"></i>
        <span>Opening card…</span>
      }
    </main>
  `,
  styles: [`
    .key-resolver { min-height: 50vh; display: grid; place-content: center; justify-items: center; gap: 8px; color: var(--text-muted); text-align: center; }
    .key-resolver i { font-size: 28px; }
    .key-resolver h1 { margin: 4px 0 0; color: var(--text); font-size: 20px; }
    .key-resolver p { margin: 0; font-size: 13px; }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `],
})
export class CardKeyRedirectPage implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  readonly cardKey = input.required<string>();
  readonly organisationKey = input.required<string>();
  readonly failed = signal(false);

  async ngOnInit() {
    try {
      const card = await this.api.get<ResolvedCardKey>(
        `/organisations/${encodeURIComponent(this.organisationKey())}/cards/by-key/${encodeURIComponent(this.cardKey())}`,
      );
      await this.router.navigate(["/b", card.boardId, "c", card.id], {
        replaceUrl: true,
        // Match the UUID route internally so BoardPage keeps its existing state/access behavior,
        // while the stable human-readable key remains the canonical browser URL.
        browserUrl: cardPath(card.organisationKey, card.key),
      });
    } catch {
      this.failed.set(true);
    }
  }
}
