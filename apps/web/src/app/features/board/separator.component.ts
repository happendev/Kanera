import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from "@angular/core";
import type { ColorToken } from "@kanera/shared/colors";
import { AutofocusDirective } from "../../shared/autofocus.directive";
import { ColorPickerComponent } from "../../shared/color-picker.component";
import type { AnySeparator } from "./board-state";

@Component({
  selector: "k-separator",
  standalone: true,
  imports: [AutofocusDirective, ColorPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="separator" [class.has-title]="!!separator().title.trim()" [class.has-color]="!!displayColor()" [style.--separator-color]="displayColor() ? 'var(--color-' + displayColor() + ')' : null">
      <span class="separator-line"></span>
      @if (separator().title.trim()) {
      <span class="separator-title">{{ separator().title }}</span>
      }
      <span class="separator-line"></span>
      @if (canEditRole()) {
      <span class="separator-actions">
        <button type="button" class="ghost icon" [disabled]="!canEdit()" (click)="startEditing()" aria-label="Edit separator">
          <i class="ti ti-pencil"></i>
        </button>
        <button type="button" class="ghost icon danger" [disabled]="!canEdit()" (click)="deleteRequested.emit(separator().id)" aria-label="Delete separator">
          <i class="ti ti-trash"></i>
        </button>
      </span>
      }
    </div>
    @if (editing()) {
    <form class="separator-edit" (submit)="save($event)">
      <input type="text" [value]="draftTitle()" (input)="draftTitle.set($any($event.target).value)" placeholder="Separator title" autofocus />
      <k-color-picker [value]="draftColor()" (valueChange)="saveColor($event)" />
      <button type="submit" class="sm"><i class="ti ti-check"></i></button>
      <button type="button" class="ghost icon" (click)="editing.set(false)" aria-label="Cancel"><i class="ti ti-x"></i></button>
    </form>
    }
  `,
  styleUrl: "./separator.component.scss",
})
export class SeparatorComponent {
  readonly separator = input.required<AnySeparator>();
  readonly canEdit = input<boolean>(true);
  // Role-only permission for structural visibility of the edit/delete actions so they stay
  // mounted across offline blips; `canEdit` (online-aware) still gates the disabled state + saves.
  readonly canEditRole = input<boolean>(true);
  readonly autoEdit = input<boolean>(false);
  readonly updated = output<{ id: string; title: string; color: ColorToken | null }>();
  readonly deleteRequested = output<string>();
  readonly editing = signal(false);
  readonly draftTitle = signal("");
  readonly draftColor = signal<ColorToken | null>(null);
  readonly displayColor = computed(() => this.editing() ? this.draftColor() : this.separator().color);
  private autoEditedSeparatorId: string | null = null;

  constructor() {
    effect(() => {
      const separator = this.separator();
      if (!this.autoEdit() || !this.canEdit() || this.autoEditedSeparatorId === separator.id) return;
      this.autoEditedSeparatorId = separator.id;
      this.startEditing();
    });
  }

  // Seed the draft once when editing opens (not via an effect on separator()): a concurrent
  // separator:updated realtime event must not clobber the title the user is mid-edit on.
  startEditing() {
    this.draftTitle.set(this.separator().title);
    this.draftColor.set(this.separator().color);
    this.editing.set(true);
  }

  save(event: Event) {
    event.preventDefault();
    this.emitUpdate();
    this.editing.set(false);
  }

  saveColor(color: ColorToken | null) {
    this.draftColor.set(color);
    this.emitUpdate();
  }

  private emitUpdate() {
    if (!this.canEdit()) return;
    this.updated.emit({
      id: this.separator().id,
      title: this.draftTitle(),
      color: this.draftColor(),
    });
  }
}
