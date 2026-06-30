import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import type { ReactionUserSummary } from "@kanera/shared/dto";
import { AvatarComponent } from "../../shared/avatar.component";

@Component({
  selector: "k-reaction-popover",
  standalone: true,
  imports: [AvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (anchor() && users().length) {
      <div class="reaction-popover" [style.top.px]="position().top" [style.left.px]="position().left">
        @for (user of users(); track user.id) {
          <div class="reactor">
            <div class="reactor-avatar">
              <k-avatar [url]="user.avatarUrl" [name]="user.displayName" [size]="20" [userId]="user.id" />
            </div>
            <span class="reactor-name">{{ user.displayName }}</span>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host { position: fixed; inset: 0; pointer-events: none; z-index: 1500; }
      .reaction-popover {
        position: fixed;
        transform: translate(-50%, calc(-100% - 6px));
        background: var(--surface-2);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 8px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        padding: 6px;
        min-width: 140px;
        max-width: 220px;
        pointer-events: none;
      }
      .reactor {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 6px;
        font-size: 12px;
        color: var(--text);
      }
      .reactor-avatar {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--accent);
        color: var(--accent-fg);
        font-size: 10px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        text-transform: uppercase;
        overflow: hidden;
        flex-shrink: 0;
      }
      .reactor-avatar img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .reactor-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class ReactionPopoverComponent {
  readonly anchor = input<HTMLElement | null>(null);
  readonly users = input<ReactionUserSummary[]>([]);

  readonly position = computed(() => {
    const el = this.anchor();
    if (!el) return { top: 0, left: 0 };
    const rect = el.getBoundingClientRect();
    return {
      top: Math.max(8, rect.top - 8),
      left: rect.left + rect.width / 2,
    };
  });

  initial(name: string): string {
    return (name || "?").charAt(0).toUpperCase();
  }
}
