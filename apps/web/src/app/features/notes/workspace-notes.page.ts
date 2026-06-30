import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { NotesViewComponent } from "./notes-view.component";

@Component({
  selector: "k-workspace-notes-page",
  standalone: true,
  imports: [NotesViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="wn-header">
      <h1 class="wn-title">
        <i class="ti ti-notebook"></i>
        <span>Notes</span>
      </h1>
    </header>
    <div class="wn-body">
      <k-notes-view [workspaceId]="workspaceId()" [boardId]="null" [noteId]="noteId()" />
    </div>
  `,
  styleUrl: "./workspace-notes.page.scss",
})
export class WorkspaceNotesPage {
  readonly workspaceId = input.required<string>();
  readonly noteId = input<string | undefined>();
}
