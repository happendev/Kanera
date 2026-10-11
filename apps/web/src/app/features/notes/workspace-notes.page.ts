import type { OnChanges, OnInit, SimpleChanges } from "@angular/core";
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from "@angular/core";
import type { ServerToClientEvents } from "@kanera/shared/events";
import { ApiClient } from "../../core/api/api.client";
import { SocketService } from "../../core/realtime/socket.service";
import { EmptyStateComponent } from "../../shared/empty-state.component";
import { PageHeaderComponent } from "../../shared/page-header.component";
import { NotesViewComponent } from "./notes-view.component";

@Component({
  selector: "k-workspace-notes-page",
  standalone: true,
  imports: [EmptyStateComponent, NotesViewComponent, PageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <k-page-header icon="notebook" iconColor="var(--accent)" title="Notes" />
    <div class="wn-body">
      @if (notesEnabled() === false) {
        <k-empty-state icon="notebook-off" title="Notes are turned off" text="A workspace admin has turned off Notes for this workspace." />
      } @else {
        <k-notes-view [workspaceId]="workspaceId()" [boardId]="null" [contextName]="workspaceName()" [noteId]="noteId()" [canEditTeamRole]="true" />
      }
    </div>
  `,
  styleUrl: "./workspace-notes.page.scss",
})
export class WorkspaceNotesPage implements OnInit, OnChanges {
  private readonly api = inject(ApiClient);
  private readonly sockets = inject(SocketService);
  private readonly destroyRef = inject(DestroyRef);
  readonly workspaceId = input.required<string>();
  readonly noteId = input<string | undefined>();
  readonly workspaceName = signal("");
  /**
   * Null until the workspace loads. The notes view renders optimistically meanwhile so the common
   * enabled case does not wait on a second request; only a confirmed `false` swaps it out.
   */
  readonly notesEnabled = signal<boolean | null>(null);
  private initialized = false;
  private loadVersion = 0;

  async ngOnInit() {
    this.initialized = true;
    // The notes view already joins this workspace's room; listening here lets an admin switching
    // Notes off (or back on) take effect on an open page without a reload.
    const socket = this.sockets.connect();
    const onWorkspaceUpdated: ServerToClientEvents["workspace:updated"] = ({ workspace }) => {
      if (workspace.id === this.workspaceId()) this.notesEnabled.set(workspace.notesEnabled);
    };
    socket.on("workspace:updated", onWorkspaceUpdated);
    this.destroyRef.onDestroy(() => socket.off("workspace:updated", onWorkspaceUpdated));
    await this.loadWorkspace();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!this.initialized || !changes["workspaceId"]) return;
    void this.loadWorkspace();
  }

  private async loadWorkspace() {
    const loadVersion = ++this.loadVersion;
    const workspaceId = this.workspaceId();
    this.workspaceName.set("");
    this.notesEnabled.set(null);
    const detail = await this.api.get<{ workspace: { name: string; notesEnabled?: boolean } }>(`/workspaces/${workspaceId}`).catch(() => null);
    if (loadVersion !== this.loadVersion || this.workspaceId() !== workspaceId) return;
    this.workspaceName.set(detail?.workspace.name ?? "");
    this.notesEnabled.set(detail ? detail.workspace.notesEnabled !== false : null);
  }
}
