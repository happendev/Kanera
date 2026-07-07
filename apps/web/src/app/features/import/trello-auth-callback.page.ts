import { DOCUMENT } from "@angular/common";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import type { OnInit } from "@angular/core";

@Component({
  selector: "k-trello-auth-callback",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="trello-auth-callback">
      <i class="ti ti-brand-trello"></i>
      <h1>{{ title }}</h1>
      <p>{{ message }}</p>
    </main>
  `,
  styles: [`
    .trello-auth-callback {
      display: grid;
      place-items: center;
      align-content: center;
      gap: 8px;
      min-height: 100vh;
      padding: 24px;
      color: var(--text);
      text-align: center;
    }

    .trello-auth-callback i {
      color: var(--accent);
      font-size: 28px;
    }

    .trello-auth-callback h1,
    .trello-auth-callback p {
      margin: 0;
    }

    .trello-auth-callback h1 {
      font-size: 16px;
      font-weight: 600;
    }

    .trello-auth-callback p {
      color: var(--text-muted);
      font-size: 13px;
    }
  `],
})
export class TrelloAuthCallbackPage implements OnInit {
  private readonly document = inject(DOCUMENT);

  title = "Connecting Trello";
  message = "You can return to Kanera in a moment.";

  ngOnInit(): void {
    const view = this.document.defaultView;
    const token = new URLSearchParams(this.document.location.hash.replace(/^#/, "")).get("token");
    const requestId = new URLSearchParams(this.document.location.search).get("requestId");
    const opener = view?.opener as Window | null | undefined;
    if (!view || !token || !opener) {
      this.title = "Trello connection incomplete";
      this.message = "Close this window and try connecting Trello again.";
      return;
    }

    // The import page owns the transient token; this callback page only ferries it
    // from Trello's fragment redirect back to the already-open importer window.
    opener.postMessage({ type: "kanera:trello-token", token, requestId }, view.location.origin);
    view.setTimeout(() => view.close(), 750);
  }
}
