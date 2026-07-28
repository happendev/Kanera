import type { OnChanges, OnInit, SimpleChanges } from "@angular/core";
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
      <k-notes-view [workspaceId]="workspaceId()" [boardId]="null" [contextName]="workspaceName()" [noteId]="noteId()" [canEditTeamRole]="workspaceRole() === 'admin'" />
    </div>
  `,
  styleUrl: "./workspace-notes.page.scss",
})
export class WorkspaceNotesPage implements OnInit, OnChanges {
  private readonly api = inject(ApiClient);
  readonly workspaceId = input.required<string>();
  readonly noteId = input<string | undefined>();
  readonly workspaceRole = signal<WorkspaceRole | null>(null);
  readonly workspaceName = signal("");
  private initialized = false;
  private loadVersion = 0;

  async ngOnInit() {
    this.initialized = true;
    await this.loadWorkspace();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!this.initialized || !changes["workspaceId"]) return;
    void this.loadWorkspace();
  }

  private async loadWorkspace() {
    const loadVersion = ++this.loadVersion;
    const workspaceId = this.workspaceId();
    this.workspaceRole.set(null);
    this.workspaceName.set("");
    const detail = await this.api.get<{ workspace: { name: string }; role: WorkspaceRole }>(`/workspaces/${workspaceId}`).catch(() => null);
    if (loadVersion !== this.loadVersion || this.workspaceId() !== workspaceId) return;
    this.workspaceRole.set(detail?.role ?? null);
    this.workspaceName.set(detail?.workspace.name ?? "");
  }
}
