import { ChangeDetectionStrategy, Component, HostListener, input, output } from "@angular/core";

export interface UpgradePromptContent {
  headline: string;
  attemptedAction: string;
  valueReceived: string;
  cost: string;
  freeConsequence: string;
  canReviewPlan: boolean;
}

@Component({
  selector: "k-upgrade-prompt-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="dismissed.emit()">
      <section class="dialog" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" [attr.aria-label]="content().headline">
        <button class="close" type="button" aria-label="Close" (click)="dismissed.emit()"><i class="ti ti-x"></i></button>
        <span class="context-label">{{ content().attemptedAction }}</span>
        <h2>{{ content().headline }}</h2>

        <div class="detail value-detail">
          <i class="ti ti-circle-check"></i>
          <div><span>Value already received</span><strong>{{ content().valueReceived }}</strong></div>
        </div>
        <div class="detail">
          <i class="ti ti-credit-card"></i>
          <div><span>Your team price</span><strong>{{ content().cost }}</strong></div>
        </div>
        <div class="detail free-detail">
          <i class="ti ti-lock"></i>
          <div><span>If you stay on Free</span><strong>{{ content().freeConsequence }}</strong></div>
        </div>

        <div class="actions">
          @if (content().canReviewPlan) {
            <button class="ghost sm" type="button" (click)="dismissed.emit()">Stay on Free</button>
            <button class="sm" type="button" (click)="reviewPlan.emit()">Review Pro and pricing</button>
          } @else {
            <button class="sm" type="button" (click)="dismissed.emit()">Got it</button>
          }
        </div>
      </section>
    </div>
  `,
  styles: `
    .backdrop { position:fixed; inset:0; z-index:var(--z-modal, 1000); display:flex; align-items:center; justify-content:center; padding:16px; background:rgba(0,0,0,.5); }
    .dialog { position:relative; width:100%; max-width:520px; padding:28px; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--surface); box-shadow:0 20px 55px rgba(0,0,0,.35); }
    .close { position:absolute; top:14px; right:14px; display:grid; place-items:center; width:32px; height:32px; padding:0; color:var(--text-muted); background:transparent; border-color:transparent; }
    .context-label { display:inline-flex; margin:0 40px 10px 0; padding:4px 8px; border-radius:999px; color:var(--accent); background:var(--accent-soft); font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
    h2 { margin:0 36px 22px 0; color:var(--text); font-size:21px; line-height:1.3; }
    .detail { display:grid; grid-template-columns:32px 1fr; gap:10px; padding:13px 0; border-top:1px solid var(--border); }
    .detail > i { display:grid; place-items:center; width:30px; height:30px; border-radius:var(--radius); color:var(--text-muted); background:var(--surface-2); }
    .detail div { display:grid; gap:3px; }
    .detail span { color:var(--text-muted); font-size:11px; font-weight:650; letter-spacing:.03em; text-transform:uppercase; }
    .detail strong { color:var(--text); font-size:13px; font-weight:550; line-height:1.45; }
    .value-detail > i { color:var(--success, #16a34a); }
    .free-detail > i { color:var(--warning, #d97706); }
    .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:22px; }
    @media (max-width:520px) { .dialog { padding:22px; } .actions { align-items:stretch; flex-direction:column-reverse; } }
  `,
})
export class UpgradePromptDialogComponent {
  readonly content = input.required<UpgradePromptContent>();
  readonly dismissed = output<void>();
  readonly reviewPlan = output<void>();

  @HostListener("document:keydown.escape")
  onEscape(): void {
    this.dismissed.emit();
  }
}
