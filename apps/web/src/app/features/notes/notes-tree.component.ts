import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import type { WireNote } from "@kanera/shared/events";
import { NoteTreeNodeComponent, type NodeDropEvent } from "./note-tree-node.component";
import { buildTree, type NoteTreeNode } from "./notes.types";

export interface NoteMoveRequest {
  noteId: string;
  newParentId: string | null;
  afterNoteId?: string | null;
  beforeNoteId?: string | null;
}

@Component({
  selector: "k-notes-tree",
  standalone: true,
  imports: [NoteTreeNodeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="nt-shell">
      <div class="nt-root">
        @if (roots().length === 0) {
          <div class="nt-empty">
            <i class="ti ti-notebook"></i>
            <span>No notes yet</span>
          </div>
        }
        @for (node of roots(); track node.id) {
          <k-note-tree-node
            [node]="node"
            [depth]="0"
            [selectedId]="selectedId()"
            [currentUserId]="currentUserId()"
            [canEdit]="canEdit()"
            [expanded]="expanded()"
            [dragState]="{ draggingId: draggingId(), dragOverId: dragOverId() }"
            (selectNode)="selectNote.emit($event)"
            (newChild)="newChild.emit($event)"
            (duplicateNode)="noteDuplicate.emit($event)"
            (deleteNode)="noteDelete.emit($event)"
            (toggleExpand)="toggleExpand($event)"
            (dragStart)="onDragStart($event.noteId)"
            (dragEnd)="onDragEnd()"
            (dragOver)="onDragOver($event.targetId)"
            (dragLeave)="onDragLeave($event)"
            (nodeDrop)="onNodeDrop($event)" />
        }

        <div
          class="nt-root-drop"
          [class.is-visible]="draggingId() !== null"
          [class.is-active]="dragOverId() === '__root__'"
          (dragover)="onRootDragOver($event)"
          (dragleave)="onDragLeave('__root__')"
          (drop)="onRootDrop($event)">
          Drop here to move to top level
        </div>
      </div>
    </div>
  `,
  styleUrl: "./notes-tree.component.scss",
})
export class NotesTreeComponent {
  readonly items = input.required<WireNote[]>();
  readonly selectedId = input<string | null>(null);
  readonly currentUserId = input<string | null>(null);
  readonly canEdit = input(true);

  readonly selectNote = output<string>();
  readonly newChild = output<string | null>();
  readonly noteDuplicate = output<string>();
  readonly noteDelete = output<string>();
  readonly move = output<NoteMoveRequest>();

  readonly expanded = signal<Record<string, boolean>>({});
  readonly draggingId = signal<string | null>(null);
  readonly dragOverId = signal<string | null>(null);

  readonly roots = computed<NoteTreeNode[]>(() => buildTree(this.items()));

  toggleExpand(id: string) {
    this.expanded.update((m) => ({ ...m, [id]: m[id] === false ? true : false }));
  }

  onDragStart(noteId: string) {
    if (!this.canEdit()) return;
    this.draggingId.set(noteId);
  }

  onDragEnd() {
    this.draggingId.set(null);
    this.dragOverId.set(null);
  }

  onDragOver(targetId: string) {
    if (!this.canEdit()) return;
    this.dragOverId.set(targetId);
  }

  onRootDragOver(event: DragEvent) {
    if (!this.canEdit()) return;
    if (!this.draggingId()) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";
    this.dragOverId.set("__root__");
  }

  onDragLeave(id: string) {
    if (this.dragOverId() === id) this.dragOverId.set(null);
  }

  onNodeDrop(event: NodeDropEvent) {
    this.draggingId.set(null);
    this.dragOverId.set(null);
    if (!this.canEdit()) return;
    if (event.placement === "before") {
      this.move.emit({ noteId: event.noteId, newParentId: event.targetParentId, beforeNoteId: event.targetId });
      return;
    }
    if (event.placement === "after") {
      this.move.emit({ noteId: event.noteId, newParentId: event.targetParentId, afterNoteId: event.targetId });
      return;
    }
    this.move.emit({ noteId: event.noteId, newParentId: event.targetId });
  }

  onRootDrop(event: DragEvent) {
    event.preventDefault();
    const noteId = this.draggingId();
    this.draggingId.set(null);
    this.dragOverId.set(null);
    if (!this.canEdit()) return;
    if (!noteId) return;
    this.move.emit({ noteId, newParentId: null });
  }
}
