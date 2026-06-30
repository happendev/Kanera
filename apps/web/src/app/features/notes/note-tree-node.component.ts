import { ChangeDetectionStrategy, Component, inject, input, output, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { TooltipDirective } from "../../shared/tooltip.directive";
import type { NoteTreeNode } from "./notes.types";

export interface TreeDragState {
  draggingId: string | null;
  dragOverId: string | null;
}

export type DropPlacement = "before" | "inside" | "after";

export interface NodeDropEvent {
  targetId: string;
  targetParentId: string | null;
  noteId: string;
  placement: DropPlacement;
}

/**
 * Recursive tree node. Stateless: receives expansion + drag state from the
 * parent NotesTreeComponent and emits events upward. Computes a fine-grained
 * drop placement (before / inside / after) based on cursor Y within the row.
 */
@Component({
  selector: "k-note-tree-node",
  standalone: true,
  imports: [TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="nt-row"
      [class.is-selected]="selectedId() === node().id"
      [class.is-drop-before]="isDragTarget() && placement() === 'before'"
      [class.is-drop-after]="isDragTarget() && placement() === 'after'"
      [class.is-drop-inside]="isDragTarget() && placement() === 'inside'"
      [style.--nt-indent.px]="depth() * 16"
      [attr.draggable]="canEdit() ? 'true' : 'false'"
      (dragstart)="onDragStart($event)"
      (dragend)="dragEnd.emit()"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeaveRow()"
      (drop)="onDropNative($event)">
      <button
        type="button"
        class="nt-expand"
        (click)="toggleExpand.emit(node().id); $event.stopPropagation()"
        [attr.aria-label]="isExpanded() ? 'Collapse' : 'Expand'">
        @if (node().children.length > 0) {
          <i [class]="isExpanded() ? 'ti ti-chevron-down' : 'ti ti-chevron-right'"></i>
        } @else {
          <span class="nt-bullet"></span>
        }
      </button>
      <a class="nt-link" [href]="noteHref(node().id)" (click)="onLinkClick($event)" draggable="false">
        <i class="nt-icon ti ti-{{ node().icon || 'file-text' }}"
          [style.color]="node().color ? 'var(--color-' + node().color + ')' : 'var(--accent)'"></i>
        <span class="nt-title">{{ node().title || 'Untitled' }}</span>
        @if (node().editingUserId && node().editingUserId !== currentUserId()) {
          <i class="nt-lock ti ti-lock" kTooltip="Being edited"></i>
        }
      </a>
      <div class="nt-actions" (click)="$event.stopPropagation()">
        @if (canAddChild()) {
        <button class="nt-act" type="button" (click)="onNewChild()" [disabled]="!canEdit()" [kTooltip]="actionTitle('Add sub-note')" aria-label="Add sub-note">
          <i class="ti ti-plus"></i>
        </button>
        }
        <button class="nt-act" type="button" (click)="onDuplicate()" [disabled]="!canEdit()" [kTooltip]="actionTitle('Duplicate')" aria-label="Duplicate">
          <i class="ti ti-copy"></i>
        </button>
        <button class="nt-act danger" type="button" (click)="onDelete()" [disabled]="!canEdit()" [kTooltip]="actionTitle('Delete')" aria-label="Delete">
          <i class="ti ti-trash"></i>
        </button>
      </div>
    </div>
    @if (node().children.length > 0 && isExpanded()) {
      @for (child of node().children; track child.id) {
        <k-note-tree-node
          [node]="child"
          [depth]="depth() + 1"
          [selectedId]="selectedId()"
          [currentUserId]="currentUserId()"
          [canEdit]="canEdit()"
          [expanded]="expanded()"
          [dragState]="dragState()"
          (selectNode)="selectNode.emit($event)"
          (newChild)="newChild.emit($event)"
          (duplicateNode)="duplicateNode.emit($event)"
          (deleteNode)="deleteNode.emit($event)"
          (toggleExpand)="toggleExpand.emit($event)"
          (dragStart)="dragStart.emit($event)"
          (dragEnd)="dragEnd.emit()"
          (dragOver)="dragOver.emit($event)"
          (dragLeave)="dragLeave.emit($event)"
          (nodeDrop)="nodeDrop.emit($event)" />
      }
    }
  `,
  styleUrl: "./note-tree-node.component.scss",
})
export class NoteTreeNodeComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly node = input.required<NoteTreeNode>();
  readonly depth = input<number>(0);
  readonly selectedId = input<string | null>(null);
  readonly currentUserId = input<string | null>(null);
  readonly canEdit = input(true);
  readonly expanded = input<Record<string, boolean>>({});
  readonly dragState = input<TreeDragState>({ draggingId: null, dragOverId: null });

  readonly selectNode = output<string>();
  readonly newChild = output<string | null>();
  readonly duplicateNode = output<string>();
  readonly deleteNode = output<string>();
  readonly toggleExpand = output<string>();
  readonly dragStart = output<{ noteId: string; event: DragEvent }>();
  readonly dragEnd = output<void>();
  readonly dragOver = output<{ targetId: string; event: DragEvent }>();
  readonly dragLeave = output<string>();
  readonly nodeDrop = output<NodeDropEvent>();

  readonly placement = signal<DropPlacement>("inside");

  noteHref(noteId: string): string {
    const tree = this.router.createUrlTree([], {
      relativeTo: this.route,
      queryParams: { noteId },
      queryParamsHandling: "merge",
    });
    return this.router.serializeUrl(tree);
  }

  onLinkClick(event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.selectNode.emit(this.node().id);
  }

  isExpanded(): boolean {
    return this.expanded()[this.node().id] !== false;
  }

  isDragTarget(): boolean {
    const state = this.dragState();
    return state.dragOverId === this.node().id && state.draggingId !== this.node().id;
  }

  canAddChild(): boolean {
    return this.depth() < 2;
  }

  actionTitle(label: string): string {
    return this.canEdit() ? label : "You're offline - changes are paused";
  }

  onNewChild() {
    if (!this.canEdit()) return;
    this.newChild.emit(this.node().id);
  }

  onDelete() {
    if (!this.canEdit()) return;
    this.deleteNode.emit(this.node().id);
  }

  onDuplicate() {
    if (!this.canEdit()) return;
    this.duplicateNode.emit(this.node().id);
  }

  onDragStart(event: DragEvent) {
    if (!this.canEdit()) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", this.node().id);
    event.dataTransfer!.effectAllowed = "move";
    this.dragStart.emit({ noteId: this.node().id, event });
  }

  onDragOver(event: DragEvent) {
    if (!this.canEdit()) return;
    const state = this.dragState();
    if (!state.draggingId || state.draggingId === this.node().id) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    this.placement.set(ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : (this.canAddChild() ? "inside" : "after"));
    this.dragOver.emit({ targetId: this.node().id, event });
  }

  onDragLeaveRow() {
    this.dragLeave.emit(this.node().id);
  }

  onDropNative(event: DragEvent) {
    event.preventDefault();
    if (!this.canEdit()) return;
    const state = this.dragState();
    if (!state.draggingId || state.draggingId === this.node().id) return;
    this.nodeDrop.emit({
      targetId: this.node().id,
      targetParentId: this.node().parentNoteId,
      noteId: state.draggingId,
      placement: this.placement(),
    });
  }
}
