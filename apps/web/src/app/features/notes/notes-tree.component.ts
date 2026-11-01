import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import type { WireNote } from "@kanera/shared/events";
import { NoteTreeNodeComponent, type TreeDragState } from "./note-tree-node.component";
import {
  resolveNoteDrop,
  visibleNoteRows,
  type NoteMoveRequest,
  type RowZone,
} from "./note-tree-drop";
import { buildTree, type NoteTreeNode } from "./notes.types";

/** Matches the per-level indent rows render with (`depth * 16` in NoteTreeNodeComponent). */
const INDENT_PX = 16;
/** Row padding plus half the 20px chevron: the line's dot sits on the chevron column of its level. */
const ROW_INSET_PX = 8 + 10;
/** How long the pointer rests on a collapsed note before it opens to show where its children are. */
const AUTO_EXPAND_MS = 600;

interface DropLine {
  top: number;
  left: number;
  label: string;
  /** The gap would nest the dragged subtree too deep; the chip explains, no line is drawn. */
  blocked: boolean;
}

interface TreeDrop {
  /** Null when dropping here changes nothing (or is not allowed). */
  move: NoteMoveRequest | null;
  insideId: string | null;
  parentId: string | null;
  atRootZone: boolean;
  line: DropLine | null;
}

@Component({
  selector: "k-notes-tree",
  standalone: true,
  imports: [NoteTreeNodeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="nt-shell">
      <div
        class="nt-root"
        (dragover)="onDragOver($event)"
        (dragleave)="onDragLeave($event)"
        (drop)="onDrop($event)">
        @if (roots().length === 0) {
          <div class="nt-empty">
            <i aria-hidden="true" class="ti ti-notebook"></i>
            <span i18n="Empty state in the notes tree">No notes yet</span>
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
            [dragState]="dragState()"
            (selectNode)="selectNote.emit($event)"
            (newChild)="newChild.emit($event)"
            (duplicateNode)="noteDuplicate.emit($event)"
            (deleteNode)="noteDelete.emit($event)"
            (toggleExpand)="toggleExpand($event)"
            (dragStart)="onDragStart($event.noteId, $event.event)"
            (dragEnd)="resetDrag()" />
        }

        @if (drop()?.line; as line) {
          <div class="nt-drop-line" [class.is-blocked]="line.blocked" [style.top.px]="line.top" [style.left.px]="line.left" aria-hidden="true">
            <span class="nt-drop-chip">
              @if (!line.blocked) { <i aria-hidden="true" class="ti ti-corner-down-right"></i> }
              <span class="nt-drop-label">{{ line.label }}</span>
            </span>
          </div>
        }

        <div
          class="nt-root-drop"
          [class.is-visible]="draggingId() !== null"
          [class.is-active]="drop()?.atRootZone"
          i18n="Drop zone in the notes tree">Drop here to move to top level</div>
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
  // dragover fires every few milliseconds; only a different target should re-render the tree.
  readonly drop = signal<TreeDrop | null>(null, { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  readonly roots = computed<NoteTreeNode[]>(() => buildTree(this.items()));
  private readonly rows = computed(() => visibleNoteRows(this.roots(), this.expanded()));
  readonly dragState = computed<TreeDragState>(() => ({
    draggingId: this.draggingId(),
    insideId: this.drop()?.insideId ?? null,
    parentId: this.drop()?.parentId ?? null,
  }));

  private readonly topLevelLabel = $localize`:Drag-and-drop hint in the notes tree - the dragged note will become a top-level note:Top level`;
  private readonly tooDeepLabel = $localize`:Drag-and-drop hint in the notes tree - the note cannot be dropped here because it would be nested too deep:Notes nest up to 3 levels`;
  private readonly untitledLabel = $localize`:Fallback title for a note without one:Untitled`;

  /** Pointer x and tree level when the drag began; sideways movement from here picks the level. */
  private dragOrigin = { x: 0, depth: 0 };
  private expandTimer: ReturnType<typeof setTimeout> | null = null;
  private expandTimerFor: string | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearExpandTimer());
  }

  toggleExpand(id: string) {
    this.expanded.update((m) => ({ ...m, [id]: m[id] === false ? true : false }));
  }

  onDragStart(noteId: string, event: DragEvent) {
    if (!this.canEdit()) return;
    const row = this.rows().find((candidate) => candidate.node.id === noteId);
    this.dragOrigin = { x: event.clientX, depth: row?.depth ?? 0 };
    this.draggingId.set(noteId);
  }

  resetDrag() {
    this.clearExpandTimer();
    this.draggingId.set(null);
    this.drop.set(null);
  }

  onDragOver(event: DragEvent) {
    const draggingId = this.draggingId();
    if (!this.canEdit() || !draggingId) return;
    event.preventDefault();
    const rootEl = event.currentTarget as HTMLElement;
    const target = event.target as Element | null;

    if (target?.closest(".nt-root-drop")) {
      const lastRoot = this.roots().at(-1);
      this.setDrop(event, {
        move: lastRoot?.id === draggingId ? null : { noteId: draggingId, newParentId: null, beforeNoteId: null },
        insideId: null,
        parentId: null,
        atRootZone: true,
        line: null,
      });
      return;
    }

    const rowEl = target?.closest<HTMLElement>(".nt-row[data-note-id]");
    // Between rows (the 1px gaps, the shell padding) keep the last target so the line doesn't flicker.
    if (!rowEl) return;
    const rowId = rowEl.dataset["noteId"]!;
    const rect = rowEl.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    const zone: RowZone = ratio < 0.25 ? "top" : ratio > 0.75 ? "bottom" : "middle";
    const desiredDepth = this.dragOrigin.depth + Math.round((event.clientX - this.dragOrigin.x) / INDENT_PX);
    const resolved = resolveNoteDrop(this.rows(), this.roots(), draggingId, { rowId, zone }, desiredDepth);
    if (!resolved) return;

    if (resolved.kind === "inside") {
      this.setDrop(event, { move: resolved.move, insideId: resolved.targetId, parentId: null, atRootZone: false, line: null });
      this.scheduleExpand(resolved.targetId);
      return;
    }
    this.clearExpandTimer();
    const lineRow = rootEl.querySelector<HTMLElement>(`.nt-row[data-note-id="${resolved.rowId}"]`) ?? rowEl;
    const lineRect = lineRow.getBoundingClientRect();
    const rootRect = rootEl.getBoundingClientRect();
    // Rows sit 1px apart; centre the line on that gap.
    const top = (resolved.edge === "top" ? lineRect.top - 0.5 : lineRect.bottom + 0.5) - rootRect.top;
    const rowLeft = lineRect.left - rootRect.left + ROW_INSET_PX;
    if (resolved.kind === "too-deep") {
      this.setDrop(event, { move: null, insideId: null, parentId: null, atRootZone: false, line: { top, left: rowLeft, label: this.tooDeepLabel, blocked: true } });
      return;
    }
    const parent = resolved.parentId ? this.rows().find((row) => row.node.id === resolved.parentId)?.node : null;
    this.setDrop(event, {
      move: resolved.move,
      insideId: null,
      parentId: resolved.parentId,
      atRootZone: false,
      line: {
        top,
        left: rowLeft + resolved.depth * INDENT_PX,
        label: parent ? parent.title || this.untitledLabel : this.topLevelLabel,
        blocked: false,
      },
    });
  }

  onDragLeave(event: DragEvent) {
    // dragleave fires on every crossing between descendants; only leaving the tree clears the target.
    const next = event.relatedTarget;
    if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return;
    this.clearExpandTimer();
    this.drop.set(null);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    const move = this.drop()?.move ?? null;
    this.resetDrag();
    if (this.canEdit() && move) this.move.emit(move);
  }

  private setDrop(event: DragEvent, drop: TreeDrop) {
    event.dataTransfer!.dropEffect = drop.line?.blocked ? "none" : "move";
    this.drop.set(drop);
  }

  private scheduleExpand(noteId: string) {
    if (this.expandTimerFor === noteId) return;
    this.clearExpandTimer();
    if (this.expanded()[noteId] !== false) return;
    this.expandTimerFor = noteId;
    this.expandTimer = setTimeout(() => {
      this.expandTimer = null;
      if (this.draggingId()) this.expanded.update((m) => ({ ...m, [noteId]: true }));
    }, AUTO_EXPAND_MS);
  }

  private clearExpandTimer() {
    if (this.expandTimer) clearTimeout(this.expandTimer);
    this.expandTimer = null;
    this.expandTimerFor = null;
  }
}
