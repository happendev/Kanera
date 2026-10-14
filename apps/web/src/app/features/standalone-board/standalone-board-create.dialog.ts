import { DialogRef } from "@angular/cdk/dialog";
import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import type { Board, Workspace } from "@kanera/shared/schema";
import type { WorkspaceTemplateId } from "@kanera/shared/workspace-templates";
import { DEFAULT_WORKSPACE_TEMPLATE, WORKSPACE_TEMPLATES } from "@kanera/shared/workspace-templates";
import { localizeWorkspaceTemplate } from "@kanera/shared/workspace-template-localize";
import { standaloneBoardCreatePayload } from "@kanera/shared/workspace-template-payload";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { translateTemplateText } from "../../core/i18n/workspace-template.messages";

type CreatedStandaloneBoard = Workspace & { initialBoard: Board };

// The board is created in the viewer's language: lists, fields, labels and starter content all come
// from the localized template, so what the preview shows is what gets created.
const LOCALIZED_TEMPLATES = WORKSPACE_TEMPLATES.map((template) => localizeWorkspaceTemplate(template, translateTemplateText));
const CREATE_FAILED = $localize`:Error when creating a standalone board fails:Could not create the board.`;
const DEFAULT_TEMPLATE = LOCALIZED_TEMPLATES.find((template) => template.id === DEFAULT_WORKSPACE_TEMPLATE.id)!;

@Component({
  selector: "k-standalone-board-create-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="create-board-dialog" aria-labelledby="create-board-title">
      <header>
        <div>
          <h2 id="create-board-title" i18n="Dialog title">New standalone board</h2>
          <p i18n>Its workflow and settings stay independent from every workspace.</p>
        </div>
        <button type="button" class="ghost icon" (click)="close()" aria-label="Close" i18n-aria-label="Button: close the dialog">
          <i class="ti ti-x"></i>
        </button>
      </header>

      <label>
        <span i18n="Form field label">Board name</span>
        <input autofocus [value]="name()" (input)="name.set($any($event.target).value)" maxlength="35" placeholder="e.g. Product launch" i18n-placeholder="Example board name" />
      </label>

      <label>
        <span i18n="Form field label: the template a new board starts from">Starting template</span>
        <select [value]="templateId()" (input)="templateId.set($any($event.target).value)">
          @for (template of templates; track template.id) {
          <option [value]="template.id" [selected]="template.id === templateId()">{{ template.name }}</option>
          }
        </select>
      </label>

      <div class="template-preview" aria-live="polite">
        <span class="template-icon"><i [class]="'ti ti-' + selectedTemplate().icon"></i></span>
        <div class="template-copy">
          <strong class="template-name">{{ selectedTemplate().name }}</strong>
          <p class="template-description">{{ selectedTemplate().description }}</p>
        </div>
      </div>

      @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
      }

      <footer>
        <button type="button" class="ghost" (click)="close()" i18n="Button: close the dialog without creating">Cancel</button>
        <button type="button" (click)="create()" [disabled]="busy() || !name().trim()">
          @if (busy()) { <ng-container i18n="Button label while the board is being created">Creating…</ng-container> } @else { <ng-container i18n="Button">Create board</ng-container> }
        </button>
      </footer>
    </section>
  `,
  styles: [`
    :host { display: block; width: min(440px, calc(100vw - 32px)); }
    .create-board-dialog { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 20px 50px rgb(0 0 0 / 18%); padding: 20px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h2 { font-size: 18px; margin: 0 0 4px; }
    p { color: var(--muted-foreground); font-size: 13px; margin: 0; }
    label { display: grid; gap: 7px; margin-top: 14px; font-size: 13px; font-weight: 600; }
    input, select { width: 100%; }
    .template-preview { display: grid; grid-template-columns: 36px minmax(0, 1fr); align-items: center; gap: 12px; margin-top: 10px; padding: 12px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
    .template-icon { display: inline-flex; width: 36px; height: 36px; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); color: var(--accent); font-size: 18px; }
    .template-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; overflow: hidden; }
    .template-name { min-width: 0; color: var(--text); font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
    .template-description { min-width: 0; color: var(--text-muted); font-size: 12px; line-height: 1.35; white-space: normal; overflow-wrap: anywhere; }
    .error { color: var(--danger); margin-top: 12px; }
    footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
  `],
})
export class StandaloneBoardCreateDialogComponent {
  private readonly api = inject(ApiClient);
  private readonly dialogRef = inject<DialogRef<string | undefined>>(DialogRef);

  readonly templates = LOCALIZED_TEMPLATES;
  readonly name = signal("");
  readonly templateId = signal<WorkspaceTemplateId>(DEFAULT_TEMPLATE.id);
  readonly selectedTemplate = computed(() =>
    this.templates.find((template) => template.id === this.templateId()) ?? DEFAULT_TEMPLATE,
  );
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  close() {
    this.dialogRef.close();
  }

  async create() {
    const name = this.name().trim();
    if (!name || this.busy()) return;
    const template = this.selectedTemplate();
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await this.api.post<CreatedStandaloneBoard>("/workspaces", {
        ...standaloneBoardCreatePayload(name, template),
      });
      this.dialogRef.close(created.initialBoard.id);
    } catch (error) {
      this.error.set(error instanceof ApiError
        ? ((error.body as { message?: string } | undefined)?.message ?? CREATE_FAILED)
        : CREATE_FAILED);
    } finally {
      this.busy.set(false);
    }
  }
}
