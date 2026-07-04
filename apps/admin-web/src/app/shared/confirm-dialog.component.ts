import { ChangeDetectionStrategy, Component, HostListener, input } from "@angular/core";
import { Subject } from "rxjs";

@Component({
  selector: "a-confirm-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="cancel()">
      <div class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="title()" (click)="$event.stopPropagation()">
        <h2>{{ title() }}</h2>
        @if (message()) { <p>{{ message() }}</p> }
        <div class="actions">
          <button class="btn" type="button" (click)="cancel()">Cancel</button>
          <button class="btn" [class.btn-danger]="danger()" type="button" (click)="accept()">{{ confirmLabel() }}</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .backdrop { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; padding: 16px; background: rgb(0 0 0 / 50%); animation: fade-in 120ms ease; }
    .dialog { width: min(400px, 100%); padding: 24px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 8px 32px rgb(0 0 0 / 40%); animation: slide-in 120ms ease; }
    h2 { margin: 0 0 8px; font-size: 15px; }
    p { margin: 0 0 20px; color: var(--text-muted); font-size: 13px; line-height: 1.5; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
    @keyframes fade-in { from { opacity: 0; } }
    @keyframes slide-in { from { opacity: 0; transform: scale(.96) translateY(-4px); } }
  `],
})
export class ConfirmDialogComponent {
  readonly title = input.required<string>();
  readonly message = input("");
  readonly confirmLabel = input("Delete");
  readonly danger = input(true);
  readonly result = new Subject<boolean>();

  accept(): void { this.close(true); }
  cancel(): void { this.close(false); }
  @HostListener("document:keydown.escape") onEscape(): void { this.cancel(); }

  private close(value: boolean): void {
    this.result.next(value);
    this.result.complete();
  }
}
