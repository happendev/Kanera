import { ChangeDetectionStrategy, Component, inject, input, output, signal } from "@angular/core";
import { ActivatedRoute, Router } from "@angular/router";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { MenuDirective } from "../../shared/menu.directive";
import type { AnchoredPanelPlacement, AnchorPoint } from "../../shared/anchored-panel";
import { TooltipDirective } from "../../shared/tooltip.directive";
import type { NoteTreeNode } from "./notes.types";

export interface TreeDragState {
  draggingId: string | null;
  /** Row the dragged note would be dropped into (middle of the row). */
  insideId: string | null;
  /** Note that becomes the parent for a between-rows drop, so the level is visible on the tree itself. */
  parentId: string | null;
}

/**
 * Recursive tree node. Stateless: receives expansion + drag state from the parent
 * NotesTreeComponent and emits events upward. The tree resolves drop targets itself from the
 * rows' `data-note-id`, because a gap's level depends on the rows around it, not just this one.
 */
@Component({
  selector: "k-note-tree-node",
  standalone: true,
  imports: [AnchoredPanelDirective, MenuDirective, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="nt-row"
      [class.is-selected]="selectedId() === node().id"
      [class.is-dragging]="isDragged()"
      [class.is-drop-inside]="dragState().insideId === node().id"
      [class.is-drop-parent]="dragState().parentId === node().id"
      [attr.data-note-id]="node().id"
      [style.--nt-indent.px]="depth() * 16"
      [attr.draggable]="canEdit() ? 'true' : 'false'"
      (dragstart)="onDragStart($event)"
      (dragend)="dragEnd.emit()"
      (contextmenu)="openContextMenu($event)">
      <button
        type="button"
        class="nt-expand"
        (click)="toggleExpand.emit(node().id); $event.stopPropagation()"
        [attr.aria-label]="isExpanded() ? collapseLabel : expandLabel">
        @if (node().children.length > 0) {
          <i aria-hidden="true" [class]="isExpanded() ? 'ti ti-chevron-down' : 'ti ti-chevron-right'"></i>
        } @else {
          <span class="nt-bullet"></span>
        }
      </button>
      <a class="nt-link" [href]="noteHref(node().id)" (click)="onLinkClick($event)" draggable="false">
        <i aria-hidden="true" class="nt-icon ti ti-{{ node().icon || 'file-text' }}"
          [style.color]="node().color ? 'var(--color-' + node().color + ')' : 'var(--accent)'"></i>
        <span class="nt-title">{{ node().title || untitledLabel }}</span>
        @if (node().editingUserId && node().editingUserId !== currentUserId()) {
          <i aria-hidden="true" class="nt-lock ti ti-lock" kTooltip="Being edited" i18n-kTooltip="Tooltip on a lock icon: another person is editing this note"></i>
        }
      </a>
      <div class="nt-actions" [class.is-open]="actionsOpen()" (click)="$event.stopPropagation()">
        <button #actionsTrigger class="nt-act" type="button" (click)="toggleActions()" [disabled]="!canEdit()" [kTooltip]="actionTitle(noteActionsLabel)" aria-label="Note actions" i18n-aria-label aria-haspopup="menu" [attr.aria-expanded]="actionsOpen()">
          <i aria-hidden="true" class="ti ti-dots"></i>
        </button>
        @if (actionsOpen()) {
        <div class="nt-actions-menu k-menu" kMenu kAnchoredPanel
          [apAnchor]="menuAt() ?? actionsTrigger"
          [apPlacement]="menuAt() ? contextMenuPlacement : actionsMenuPlacement"
          (apDismissed)="closeActions()" (contextmenu)="$event.preventDefault()" role="menu">
          <button type="button" class="k-menu-item" (click)="openInNewTab()" role="menuitem">
            <i aria-hidden="true" class="ti ti-external-link"></i><span i18n="Context menu item">Open in new tab</span>
          </button>
          <!-- Right-click still opens the menu offline, so the note can be opened in a new tab; the
               edit actions are hidden rather than disabled because they cannot run. -->
          @if (canEdit()) {
          @if (canAddChild()) {
          <button type="button" class="k-menu-item" (click)="onNewChild(); closeActions()" role="menuitem">
            <i aria-hidden="true" class="ti ti-plus"></i><span i18n="Menu item: create a child note">Add sub-note</span>
          </button>
          }
          <button type="button" class="k-menu-item" (click)="onDuplicate(); closeActions()" role="menuitem">
            <i aria-hidden="true" class="ti ti-copy"></i><span i18n="Menu item: duplicate the note">Duplicate</span>
          </button>
          <button class="k-menu-item danger" type="button" (click)="onDelete(); closeActions()" role="menuitem">
            <i aria-hidden="true" class="ti ti-trash"></i><span i18n="Menu item: delete the note">Delete</span>
          </button>
          }
        </div>
        }
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
          [inDraggedSubtree]="isDragged()"
          (selectNode)="selectNode.emit($event)"
          (newChild)="newChild.emit($event)"
          (duplicateNode)="duplicateNode.emit($event)"
          (deleteNode)="deleteNode.emit($event)"
          (toggleExpand)="toggleExpand.emit($event)"
          (dragStart)="dragStart.emit($event)"
          (dragEnd)="dragEnd.emit()" />
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
  readonly dragState = input<TreeDragState>({ draggingId: null, insideId: null, parentId: null });
  /** True for descendants of the dragged note: they travel with it, so they dim with it. */
  readonly inDraggedSubtree = input(false);

  readonly selectNode = output<string>();
  readonly newChild = output<string | null>();
  readonly duplicateNode = output<string>();
  readonly deleteNode = output<string>();
  readonly toggleExpand = output<string>();
  readonly dragStart = output<{ noteId: string; event: DragEvent }>();
  readonly dragEnd = output<void>();

  protected readonly collapseLabel = $localize`:Button label - collapse a note's children in the tree:Collapse`;
  protected readonly expandLabel = $localize`:Button label - expand a note's children in the tree:Expand`;
  protected readonly untitledLabel = $localize`:Fallback title for a note without one:Untitled`;
  protected readonly noteActionsLabel = $localize`:Tooltip on the note actions menu button:Note actions`;

  readonly actionsOpen = signal(false);
  /** Cursor position when the menu was opened by right-click; null when opened from the dots button. */
  readonly menuAt = signal<AnchorPoint | null>(null);
  readonly actionsMenuPlacement: AnchoredPanelPlacement = {
    side: "bottom",
    align: "end",
    width: "measure",
    maxHeight: 160,
    minHeight: 116,
    gap: 4,
    margin: 6,
  };
  readonly contextMenuPlacement: AnchoredPanelPlacement = { width: 190, maxHeight: 220, minHeight: 116 };

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

  isDragged(): boolean {
    return this.inDraggedSubtree() || this.dragState().draggingId === this.node().id;
  }

  canAddChild(): boolean {
    return this.depth() < 2;
  }

  actionTitle(label: string): string {
    return this.canEdit() ? label : $localize`:Tooltip on a disabled control while offline:You're offline - changes are paused`;
  }

  toggleActions() {
    if (!this.canEdit()) return;
    this.menuAt.set(null);
    this.actionsOpen.update((open) => !open);
  }

  openContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.menuAt.set({ x: event.clientX, y: event.clientY });
    this.actionsOpen.set(true);
  }

  closeActions() {
    this.actionsOpen.set(false);
    this.menuAt.set(null);
  }

  openInNewTab() {
    this.closeActions();
    window.open(this.noteHref(this.node().id), "_blank", "noopener");
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
    this.setDragPreview(event);
    this.dragStart.emit({ noteId: this.node().id, event });
  }

  /**
   * The browser's default preview is a full-width copy of the row centred where it was grabbed, which
   * covers the tree's drop line and its level chip. A compact pill below and right of the pointer
   * keeps the rows around the pointer, and the line between them, in view.
   */
  private setDragPreview(event: DragEvent) {
    if (!event.dataTransfer?.setDragImage) return;
    const node = this.node();
    // The transparent padding is the offset: setDragImage's own offset cannot go negative everywhere.
    const ghost = document.createElement("div");
    ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:20px 0 0 18px;pointer-events:none;";
    const pill = document.createElement("div");
    pill.style.cssText = [
      "display:flex", "align-items:center", "gap:6px", "max-width:200px", "height:var(--h-sm)", "padding:0 10px",
      "border-radius:var(--radius)", "background:var(--surface)", "color:var(--text)", "font-size:var(--text-sm)", "font-weight:600",
      "box-shadow:var(--shadow-drag), inset 0 0 0 1px var(--border)", "white-space:nowrap",
    ].join(";");
    const icon = document.createElement("i");
    icon.className = `ti ti-${node.icon || "file-text"}`;
    icon.style.color = node.color ? `var(--color-${node.color})` : "var(--accent)";
    const title = document.createElement("span");
    title.style.cssText = "overflow:hidden;text-overflow:ellipsis;";
    title.textContent = node.title || this.untitledLabel;
    pill.append(icon, title);
    ghost.append(pill);
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 0, 0);
    // The image is captured when dragstart returns; the element is not needed after that.
    setTimeout(() => ghost.remove());
  }
}
