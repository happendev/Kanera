import { ChangeDetectionStrategy, Component, HostListener, input } from "@angular/core";
import { Subject } from "rxjs";

@Component({
  selector: "k-confirm-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="cancel()">
      <div class="dialog" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="title()">
        <h3 class="title">{{ title() }}</h3>
        @if (message()) {
          <p class="message">{{ message() }}</p>
        }
        <div class="actions">
          <button type="button" class="ghost sm" (click)="cancel()">Cancel</button>
          <button type="button" [class]="'sm' + (danger() ? ' danger' : '')" (click)="confirm()">{{ confirmLabel() }}</button>
        </div>
      </div>
    </div>
  `,
  styles: `
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      animation: fade-in 120ms ease;
    }

    .dialog {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      padding: 24px;
      width: 100%;
      max-width: 400px;
      animation: slide-in 120ms ease;
    }

    .title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      margin: 0 0 8px;
    }

    .message {
      font-size: 13px;
      color: var(--text-muted);
      margin: 0 0 20px;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    button.danger {
      background: var(--danger);
      border-color: var(--danger);
      color: #fff;
      &:hover { opacity: 0.9; }
    }

    @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes slide-in { from { opacity: 0; transform: scale(0.96) translateY(-4px) } to { opacity: 1; transform: none } }
  `,
})
export class ConfirmDialogComponent {
  readonly title = input.required<string>();
  readonly message = input("");
  readonly confirmLabel = input("Delete");
  readonly danger = input(true);

  readonly result = new Subject<boolean>();

  confirm() {
    this.result.next(true);
    this.result.complete();
  }

  cancel() {
    this.result.next(false);
    this.result.complete();
  }

  @HostListener("document:keydown.escape")
  onEscape() {
    this.cancel();
  }
}
