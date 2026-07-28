import type { OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import type { WorkspaceRole } from "@kanera/shared/schema";
import { ApiClient } from "../../core/api/api.client";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { NotesViewComponent } from "./notes-view.component";

@Component({
  selector: "k-workspace-notes-page",
  standalone: true,
  imports: [NotesViewComponent, PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-page-header icon="notebook" iconColor="var(--accent)" title="Notes" />
    <div class="wn-body">
      <k-notes-view [workspaceId]="workspaceId()" [boardId]="null" [noteId]="noteId()" [canEditTeamRole]="workspaceRole() === 'admin'" />
    </div>
  `,
  styleUrl: "./workspace-notes.page.scss",
})
export class WorkspaceNotesPage implements OnInit {
  private readonly api = inject(ApiClient);
  readonly workspaceId = input.required<string>();
  readonly noteId = input<string | undefined>();
  readonly workspaceRole = signal<WorkspaceRole | null>(null);

  async ngOnInit() {
    const workspaceId = this.workspaceId();
    const detail = await this.api.get<{ role: WorkspaceRole }>(`/workspaces/${workspaceId}`).catch(() => null);
    if (this.workspaceId() === workspaceId) this.workspaceRole.set(detail?.role ?? null);
  }
}
