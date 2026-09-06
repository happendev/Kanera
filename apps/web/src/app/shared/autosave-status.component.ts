import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import type { AutosaveState } from "./autosave-tracker";

/**
 * Save-state chip for forms without a Save button. Renders nothing while idle so it only draws the
 * eye when something is happening. Pass `hint` to render the "saves automatically" sentence beside
 * it; hosts that already explain this in their section copy leave it off.
 */
@Component({
  selector: "k-autosave-status",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hint(); as hint) { <p class="hint">{{ hint }}</p> }
    <span class="chip" [attr.data-state]="state()" role="status" aria-live="polite">
      @switch (state()) {
        @case ('saving') { <i class="ti ti-loader-2 spin" aria-hidden="true"></i><span>Saving…</span> }
        @case ('saved') { <i class="ti ti-check" aria-hidden="true"></i><span>Saved</span> }
        @case ('error') { <i class="ti ti-alert-circle" aria-hidden="true"></i><span>Not saved</span> }
      }
    </span>
  `,
  styles: `
    :host { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; }
    .hint { margin: 0; color: var(--text-muted); font-size: 12.5px; }
    .chip {
      display: inline-flex; align-items: center; gap: 5px; margin-left: auto; min-height: 22px; padding: 0 8px;
      border-radius: 999px; color: var(--text-muted); font-size: 12px; font-weight: 500; white-space: nowrap;
      transition: opacity var(--motion-fast);
    }
    .chip:empty { opacity: 0; }
    .chip i { font-size: 14px; }
    .chip[data-state="saved"] { color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent); }
    .chip[data-state="error"] { color: var(--danger); background: var(--danger-bg); }
    .chip[data-state="saving"] { background: var(--surface-2); }
    .spin { animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `,
})
export class AutosaveStatusComponent {
  readonly state = input.required<AutosaveState>();
  readonly hint = input<string | null>(null);
}
