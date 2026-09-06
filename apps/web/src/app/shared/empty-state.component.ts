import { booleanAttribute, ChangeDetectionStrategy, Component, input } from "@angular/core";

/**
 * The one empty state. Every list, table group, panel and settings tab that can be empty renders
 * this rather than a bespoke "No X yet." span, so first-run screens read as one considered system:
 * a quiet glyph, a short sentence, and at most one action projected into the slot.
 *
 * `size="sm"` is for inline gaps inside a settings section or a drawer; the default is for a page
 * or panel whose whole content area is empty.
 */
@Component({
  selector: "k-empty-state",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class.is-sm]": "size() === 'sm'", "[class.is-plain]": "plain()", "[class.is-success]": "tone() === 'success'", role: "status" },
  template: `
    <i class="es-icon ti" [class]="'es-icon ti ti-' + icon()" aria-hidden="true"></i>
    <p class="es-title">{{ title() }}</p>
    @if (text(); as copy) {
      <p class="es-text">{{ copy }}</p>
    }
    <ng-content />
  `,
  styles: `
    :host {
      display: grid;
      justify-items: center;
      gap: var(--space-1);
      padding: var(--space-8) var(--space-4);
      text-align: center;
      color: var(--text-muted);
      border: 1px dashed var(--border);
      border-radius: var(--radius-md);
    }

    :host.is-sm {
      padding: var(--space-4) var(--space-3);
      gap: 2px;
    }

    /* For a whole pane that is empty (an editor with nothing selected, a sidebar with no
       workspaces): the surrounding surface is the frame, so the dashed box would be a box in a box. */
    :host.is-plain {
      border: 0;
      padding-block: var(--space-8);
    }

    .es-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      margin-bottom: var(--space-1);
      border-radius: 50%;
      background: var(--surface-2);
      color: var(--text-muted);
      font-size: 18px;
    }

    /* The one empty state that earns colour is "nothing left to do", and it reads as completion
       (--success) rather than as the workspace accent, which inside a drawer means unread. */
    :host.is-success .es-icon {
      background: color-mix(in srgb, var(--success) 10%, transparent);
      color: var(--success);
    }

    :host.is-sm .es-icon {
      width: 28px;
      height: 28px;
      font-size: 15px;
      margin-bottom: 2px;
    }

    .es-title {
      margin: 0;
      color: var(--text);
      font-size: var(--text-base);
      font-weight: 600;
    }

    .es-text {
      margin: 0;
      max-width: 36ch;
      font-size: var(--text-sm);
      line-height: 1.45;
    }

    :host ::ng-deep > button,
    :host ::ng-deep > a {
      margin-top: var(--space-2);
    }
  `,
})
export class EmptyStateComponent {
  readonly icon = input.required<string>();
  readonly title = input.required<string>();
  readonly text = input<string | null>(null);
  readonly size = input<"sm" | "md">("md");
  readonly plain = input(false, { transform: booleanAttribute });
  readonly tone = input<"neutral" | "success">("neutral");
}
