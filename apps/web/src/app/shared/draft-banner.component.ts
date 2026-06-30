import { ChangeDetectionStrategy, Component, computed, input, output } from "@angular/core";
import { TooltipDirective } from "./tooltip.directive";

@Component({
  selector: "k-draft-banner",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="draft-banner" role="status">
      <i class="ti ti-notes"></i>
      <span>{{ message() }}</span>
      @if (mode() === 'saved' && showEdit()) {
        <button type="button" class="ghost xs draft-banner-action" [disabled]="!editEnabled()" (click)="edit.emit()" aria-label="Edit saved draft" kTooltip="Edit draft">
          <i class="ti ti-pencil"></i>
        </button>
      }
      <button type="button" class="ghost xs draft-banner-action" (click)="discard.emit()" [attr.aria-label]="discardLabel()" kTooltip="Discard draft">
        <i class="ti ti-x"></i>
      </button>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .draft-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      padding: 5px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface-2);
      color: var(--text-muted);
      font-size: 12px;
    }

    i {
      color: var(--text-muted);
      font-size: 13px;
    }

    span {
      flex: 1;
    }

    button.xs.draft-banner-action {
      flex: 0 0 24px;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text-muted);
    }

    button.xs.draft-banner-action:hover,
    button.xs.draft-banner-action:focus-visible {
      background: var(--surface-hover);
      color: var(--text);
    }
  `,
})
export class DraftBannerComponent {
  readonly mode = input.required<"recovered" | "saved">();
  readonly canEdit = input(true);
  readonly canStartEdit = input<boolean | null>(null);
  readonly showEdit = input(true);
  readonly edit = output<void>();
  readonly discard = output<void>();

  readonly message = computed(() => {
    if (this.mode() === "recovered") return "Unsaved draft.";
    return this.canEdit() ? "Unsaved draft - click to continue editing." : "Saved as draft. Reconnect to publish.";
  });

  readonly editEnabled = computed(() => this.canStartEdit() ?? this.canEdit());
  readonly discardLabel = computed(() => this.mode() === "recovered" ? "Discard recovered draft" : "Discard saved draft");
}
