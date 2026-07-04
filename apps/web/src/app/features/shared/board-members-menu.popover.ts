import type { AfterViewInit, OnDestroy, OnInit } from "@angular/core";
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, inject, input, output, signal } from "@angular/core";
import type { ServerToClientEvents, WireBoardMemberUser } from "@kanera/shared/events";
import type { WorkspaceMember } from "@kanera/shared/schema";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { SocketService, type AppSocket } from "../../core/realtime/socket.service";
import { AvatarComponent } from "../../shared/avatar.component";
import { ConfirmService } from "../../shared/confirm.service";
import { TooltipDirective } from "../../shared/tooltip.directive";

type BoardRole = "editor" | "observer";
type WorkspaceMemberRow = WorkspaceMember & { email: string; displayName: string; avatarUrl: string | null; lastOnlineAt?: string | Date | null };
export type BoardAccessMemberRow = {
  boardId: string; userId: string; role: BoardRole; assignedItemsOnly?: boolean; pinned: boolean; addedAt: string | Date;
  email: string; displayName: string; avatarUrl: string | null; lastOnlineAt?: string | Date | null; clientId: string;
};

const memberRoleRank: Record<string, number> = {
  owner: 0,
  admin: 0,
  editor: 1,
  member: 1,
  observer: 2,
};

function sortMembers<T extends WireBoardMemberUser | BoardAccessMemberRow>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    const aRank = "pinned" in a && a.pinned ? 0 : (memberRoleRank[a.role] ?? 99);
    const bRank = "pinned" in b && b.pinned ? 0 : (memberRoleRank[b.role] ?? 99);
    return aRank - bRank || a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { message?: string } | undefined;
    return body?.message ?? error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

@Component({
  selector: "k-board-members-menu",
  standalone: true,
  imports: [AvatarComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bmp-panel" (click)="$event.stopPropagation()">
      @if (canManage() && !loading() && candidates().length > 0) {
        <form class="bmp-add" (submit)="$event.preventDefault(); addMember()">
          <select aria-label="Member to add" [value]="addUserId()" (input)="addUserId.set($any($event.target).value)" [disabled]="busy() || candidates().length === 0">
            <option value="" [selected]="!addUserId()">Select a member…</option>
            @for (candidate of candidates(); track candidate.userId) {
              <option [value]="candidate.userId" [selected]="candidate.userId === addUserId()">{{ candidate.displayName }}</option>
            }
          </select>
          <select aria-label="Role" [value]="addRole()" (input)="addRole.set($any($event.target).value)" [disabled]="busy()">
            <option value="observer" [selected]="addRole() === 'observer'">Observer</option>
            <option value="editor" [selected]="addRole() === 'editor'">Editor</option>
          </select>
          <button type="submit" [disabled]="busy() || !addUserId()" aria-label="Add member"><i class="ti ti-user-plus"></i></button>
          <button class="bmp-access-toggle bmp-add-access" type="button" [class.is-active]="addAssignedItemsOnly()" [attr.aria-pressed]="addAssignedItemsOnly()" (click)="addAssignedItemsOnly.update(value => !value)" [disabled]="busy()" [title]="assignedItemsOnlyTooltip(addAssignedItemsOnly())">
            <i [class]="addAssignedItemsOnly() ? 'ti ti-lock' : 'ti ti-lock-open'"></i>
            <span>Assigned items only</span>
          </button>
        </form>
      } @else if (canManage() && !loading() && candidates().length === 0 && !error()) {
        <div class="bmp-all-added">
          <i class="ti ti-user-check"></i>
          <span>All workspace members are already on this board.</span>
        </div>
      }
      @if (error()) { <p class="bmp-error"><i class="ti ti-alert-circle"></i> {{ error() }}</p> }
      @if (loading()) { <p class="bmp-empty"><i class="ti ti-loader-2 spin"></i> Loading members…</p> }
      @else {
        <section class="bmp-section">
          <div class="bmp-section-title">Members</div>
          @for (member of localMembers(); track member.userId) {
            <div class="bmp-row">
              <div class="bmp-identity">
                <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [size]="30" [userId]="member.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="member.lastOnlineAt ?? null" />
                <div class="bmp-person">
                  <span class="bmp-name" [title]="member.displayName">{{ member.displayName }}</span>
                  @if (member.userId === currentUserId()) { <span class="bmp-you">You</span> }
                  @else if (isAccessRow(member) && member.email) { <span class="bmp-email" [title]="member.email">{{ member.email }}</span> }
                </div>
              </div>
              <div class="bmp-actions">
                @if (canManage() && isAccessRow(member)) {
                  @if (member.pinned) { <span class="bmp-role bmp-role-admin">Admin</span> }
                  @else {
                    <select class="bmp-role-select" [attr.aria-label]="'Role for ' + member.displayName" [value]="member.role" (input)="changeRole(member.userId, $any($event.target).value)" [disabled]="busy()">
                      <option value="observer" [selected]="member.role === 'observer'">Observer</option>
                      <option value="editor" [selected]="member.role === 'editor'">Editor</option>
                    </select>
                    <button class="bmp-access-toggle" type="button" [class.is-active]="member.assignedItemsOnly" [attr.aria-pressed]="member.assignedItemsOnly" (click)="changeRestriction(member, !member.assignedItemsOnly)" [disabled]="busy()" [attr.aria-label]="'Assigned items only for ' + member.displayName" [title]="assignedItemsOnlyTooltip(!!member.assignedItemsOnly)"><i [class]="member.assignedItemsOnly ? 'ti ti-lock' : 'ti ti-lock-open'"></i></button>
                    <button class="bmp-remove" type="button" (click)="removeMember(member)" [disabled]="busy()" [attr.aria-label]="'Remove ' + member.displayName"><i class="ti ti-trash"></i></button>
                  }
                } @else {
                  <span class="bmp-role">{{ roleLabel(member.role) }}</span>
                  @if (member.assignedItemsOnly) { <span class="bmp-access-readonly" kTooltip="This member can only see cards assigned directly or through a checklist item." tabindex="0" aria-label="Assigned items only"><i class="ti ti-lock"></i></span> }
                }
              </div>
            </div>
          } @empty { <p class="bmp-empty">No board members</p> }
        </section>
        @if (guests().length > 0) {
          <section class="bmp-section bmp-guests">
            <div class="bmp-section-title">Guests</div>
            @for (guest of guests(); track guest.userId) {
              <div class="bmp-row">
                <div class="bmp-identity">
                  <k-avatar [url]="guest.avatarUrl" [name]="guest.displayName" [size]="30" [userId]="guest.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="guest.lastOnlineAt ?? null" />
                  <div class="bmp-person">
                    <span class="bmp-name" [title]="guest.displayName">{{ guest.displayName }}</span>
                    @if (guest.userId === currentUserId()) { <span class="bmp-you">You</span> }
                  </div>
                </div>
                <div class="bmp-actions">
                  @if (canManage() && isAccessRow(guest)) {
                    <select class="bmp-role-select" [attr.aria-label]="'Role for ' + guest.displayName" [value]="guest.role" (input)="changeRole(guest.userId, $any($event.target).value)" [disabled]="busy()">
                      <option value="observer" [selected]="guest.role === 'observer'">Observer</option>
                      <option value="editor" [selected]="guest.role === 'editor'">Editor</option>
                    </select>
                    <button class="bmp-access-toggle" type="button" [class.is-active]="guest.assignedItemsOnly" [attr.aria-pressed]="guest.assignedItemsOnly" (click)="changeRestriction(guest, !guest.assignedItemsOnly)" [disabled]="busy()" [attr.aria-label]="'Assigned items only for ' + guest.displayName" [title]="assignedItemsOnlyTooltip(!!guest.assignedItemsOnly)"><i [class]="guest.assignedItemsOnly ? 'ti ti-lock' : 'ti ti-lock-open'"></i></button>
                    <button class="bmp-remove" type="button" (click)="removeMember(guest)" [disabled]="busy()" [attr.aria-label]="'Remove ' + guest.displayName"><i class="ti ti-trash"></i></button>
                  } @else {
                    <span class="bmp-role">{{ roleLabel(guest.role) }}</span>
                    @if (guest.assignedItemsOnly) { <span class="bmp-access-readonly" kTooltip="This guest can only see cards assigned directly or through a checklist item." tabindex="0" aria-label="Assigned items only"><i class="ti ti-lock"></i></span> }
                  }
                </div>
              </div>
            }
            @if (!canManage()) { <p class="bmp-hint">Guests are managed in workspace settings.</p> }
          </section>
        }
      }
    </div>
  `,
  styles: `
    :host{position:fixed;z-index:300;visibility:hidden}:host(.is-positioned){visibility:visible}.bmp-panel{width:320px;max-height:min(520px,calc(100vh - 24px));overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding:12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius-lg);box-shadow:0 8px 32px rgba(0,0,0,.25)}
    .bmp-add{display:grid;grid-template-columns:1fr 92px 34px;gap:6px}.bmp-add select,.bmp-role-select{min-width:0;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-size:12px}.bmp-add button,.bmp-remove{border:0;border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);cursor:pointer}.bmp-add .bmp-add-access{grid-column:1/-1;width:100%;justify-content:flex-start;padding:0 9px;border:1px solid var(--border);background:transparent;color:var(--text-muted)}.bmp-add .bmp-add-access.is-active{border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}.bmp-remove{width:28px;height:28px;color:var(--danger)}button:disabled,select:disabled{cursor:not-allowed;opacity:.55}.bmp-all-added{display:flex;align-items:center;gap:7px;padding:8px 9px;border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text-muted);font-size:12px}.bmp-all-added i{color:var(--text)}
    .bmp-section{display:flex;flex-direction:column;gap:4px}.bmp-guests{padding-top:8px;border-top:1px solid var(--border)}.bmp-section-title{padding:0 4px 4px;color:var(--text-muted);font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}.bmp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;min-height:44px;padding:6px;border-radius:var(--radius-sm)}.bmp-row:hover{background:var(--surface-2)}.bmp-identity{display:flex;min-width:0;align-items:center;gap:8px}.bmp-person{display:flex;min-width:0;flex:1;flex-direction:column;gap:1px}.bmp-name,.bmp-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bmp-name{color:var(--text);font-size:13px;font-weight:600}.bmp-email,.bmp-you{color:var(--text-muted);font-size:10px}.bmp-actions{display:flex;flex:0 0 auto;align-items:center;gap:4px}.bmp-access-toggle{display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-muted);font-size:12px;cursor:pointer;transition:background .15s ease,border-color .15s ease,color .15s ease}.bmp-access-toggle:hover{background:var(--surface-2);color:var(--text)}.bmp-access-toggle.is-active{border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)}.bmp-access-readonly{display:inline-flex;width:22px;height:22px;align-items:center;justify-content:center;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);font-size:11px;transition:background .15s ease,box-shadow .15s ease}.bmp-access-readonly:hover,.bmp-access-readonly:focus-visible{background:color-mix(in srgb,var(--accent) 22%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 20%,transparent);outline:0}.bmp-role{color:var(--text-muted);font-size:11px;font-weight:600}.bmp-role-admin{padding:4px 7px;border-radius:999px;background:var(--surface-2)}.bmp-role-select{width:84px;height:28px}.bmp-empty,.bmp-hint,.bmp-error{margin:0;padding:6px;color:var(--text-muted);font-size:12px}.bmp-hint{padding-top:2px;font-size:11px}.bmp-error{color:var(--danger)}
  `,
})
// The product-facing name intentionally mirrors the selector; this is a menu that uses popover positioning.
// eslint-disable-next-line @angular-eslint/component-class-suffix
export class BoardMembersMenu implements OnInit, AfterViewInit, OnDestroy {
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly api = inject(ApiClient);
  private readonly confirm = inject(ConfirmService);
  private readonly sockets = inject(SocketService);
  readonly boardId = input.required<string>(); readonly workspaceId = input<string | null>(null); readonly ownerClientId = input<string | null>(null);
  readonly currentUserId = input<string | null>(null); readonly canManage = input(false); readonly members = input<WireBoardMemberUser[]>([]); readonly dismissed = output<void>();
  readonly accessMembers = signal<BoardAccessMemberRow[]>([]); readonly roster = signal<WorkspaceMemberRow[]>([]); readonly loading = signal(false); readonly busy = signal(false); readonly error = signal<string | null>(null); readonly addUserId = signal(""); readonly addRole = signal<BoardRole>("observer"); readonly addAssignedItemsOnly = signal(false);
  readonly renderedMembers = computed(() => this.canManage() ? this.accessMembers() : this.members());
  readonly localMembers = computed(() => sortMembers(this.renderedMembers().filter((m) => m.clientId === this.ownerClientId())));
  readonly guests = computed(() => sortMembers(this.renderedMembers().filter((m) => m.clientId !== this.ownerClientId())));
  readonly candidates = computed(() => { const present = new Set(this.accessMembers().map((m) => m.userId)); return this.roster().filter((m) => !present.has(m.userId)); });
  private anchorEl: HTMLElement | null = null; private socket: AppSocket | null = null; private leaveBoard?: () => void; private readonly reposition = () => this.position();

  async ngOnInit() {
    if (!this.canManage()) return;
    this.socket = this.sockets.connect(); this.leaveBoard = this.sockets.joinBoard(this.boardId());
    this.socket.on("board:member:added", this.onMemberUpsert); this.socket.on("board:member:updated", this.onMemberUpsert); this.socket.on("board:member:removed", this.onMemberRemoved); this.socket.on("client:user:role-changed", this.onClientUserRoleChanged);
    await this.reload();
  }
  ngAfterViewInit() { this.anchorEl = this.hostEl.nativeElement.parentElement; this.position(); window.addEventListener("resize", this.reposition); window.addEventListener("scroll", this.reposition, true) }
  ngOnDestroy() { window.removeEventListener("resize", this.reposition); window.removeEventListener("scroll", this.reposition, true); this.socket?.off("board:member:added", this.onMemberUpsert); this.socket?.off("board:member:updated", this.onMemberUpsert); this.socket?.off("board:member:removed", this.onMemberRemoved); this.socket?.off("client:user:role-changed", this.onClientUserRoleChanged); this.leaveBoard?.() }
  isAccessRow(member: WireBoardMemberUser | BoardAccessMemberRow): member is BoardAccessMemberRow { return "pinned" in member; }
  roleLabel(role: string) { return role.charAt(0).toUpperCase() + role.slice(1) }
  assignedItemsOnlyTooltip(restricted: boolean) { return restricted ? "Restricted to assigned cards — click to allow access to every card on this board." : "Access to all cards — click to show only cards assigned directly or through a checklist item." }
  async addMember() { const userId = this.addUserId(); if (!userId || this.busy()) return; this.busy.set(true); this.error.set(null); try { await this.api.post(`/boards/${this.boardId()}/members`, { userId, role: this.addRole(), assignedItemsOnly: this.addAssignedItemsOnly() }); this.addUserId.set(""); this.addAssignedItemsOnly.set(false); await this.reload(false) } catch (e) { this.error.set(errorMessage(e)) } finally { this.busy.set(false) } }
  async changeRole(userId: string, role: BoardRole) { if (this.busy()) return; const previous = this.accessMembers(); this.accessMembers.update(rows => rows.map(row => row.userId === userId ? { ...row, role } : row)); this.busy.set(true); this.error.set(null); try { await this.api.patch(`/boards/${this.boardId()}/members/${userId}`, { role }) } catch (e) { this.accessMembers.set(previous); this.error.set(errorMessage(e)) } finally { this.busy.set(false) } }
  async changeRestriction(member: BoardAccessMemberRow, assignedItemsOnly: boolean) { if (this.busy()) return; const previous = this.accessMembers(); this.accessMembers.update(rows => rows.map(row => row.userId === member.userId ? { ...row, assignedItemsOnly } : row)); this.busy.set(true); this.error.set(null); try { await this.api.patch(`/boards/${this.boardId()}/members/${member.userId}`, { role: member.role, assignedItemsOnly }) } catch (e) { this.accessMembers.set(previous); this.error.set(errorMessage(e)) } finally { this.busy.set(false) } }
  async removeMember(member: BoardAccessMemberRow) { if (this.busy() || !await this.confirm.open({ title: `Remove ${member.displayName}?`, message: "They will lose access to this board." })) return; this.busy.set(true); this.error.set(null); try { await this.api.delete(`/boards/${this.boardId()}/members/${member.userId}`); this.accessMembers.update(rows => rows.filter(row => row.userId !== member.userId)) } catch (e) { this.error.set(errorMessage(e)) } finally { this.busy.set(false) } }
  private async reload(showLoading = true) { if (showLoading) this.loading.set(true); this.error.set(null); try { const [members, roster] = await Promise.all([this.api.get<BoardAccessMemberRow[]>(`/boards/${this.boardId()}/members`), this.workspaceId() ? this.api.get<WorkspaceMemberRow[]>(`/workspaces/${this.workspaceId()}/members`) : Promise.resolve([])]); this.accessMembers.set(members); this.roster.set(roster) } catch (e) { this.error.set(errorMessage(e)) } finally { this.loading.set(false) } }
  // Realtime events omit email/addedAt, so preserve the authoritative row where possible and
  // borrow identity fields from the workspace roster until the next full fetch.
  private readonly onMemberUpsert = ({ boardId, member, user }: Parameters<ServerToClientEvents["board:member:added"]>[0]) => { if (boardId !== this.boardId()) return; this.accessMembers.update(rows => { const old = rows.find(r => r.userId === member.userId); const roster = this.roster().find(r => r.userId === member.userId); const next: BoardAccessMemberRow = { boardId, userId: member.userId, role: member.role, assignedItemsOnly: member.assignedItemsOnly, pinned: member.pinned, addedAt: old?.addedAt ?? new Date(), email: old?.email ?? roster?.email ?? "", displayName: user.displayName, avatarUrl: user.avatarUrl, lastOnlineAt: user.lastOnlineAt, clientId: user.clientId ?? old?.clientId ?? this.ownerClientId() ?? "" }; return [...rows.filter(r => r.userId !== member.userId), next] }) };
  private readonly onMemberRemoved = ({ boardId, userId }: { boardId: string; userId: string }) => { if (boardId === this.boardId()) this.accessMembers.update(rows => rows.filter(r => r.userId !== userId)) };
  private readonly onClientUserRoleChanged = () => { void this.reload(false) };
  private position() { if (!this.anchorEl) return; const host = this.hostEl.nativeElement, rect = this.anchorEl.getBoundingClientRect(), w = 320, m = 8; const left = Math.max(m, Math.min(rect.left, window.innerWidth - w - m)); const h = host.offsetHeight || 420; let top = rect.bottom + 6; if (top + h > window.innerHeight - m) top = Math.max(m, rect.top - 6 - h); host.style.top = `${top}px`; host.style.left = `${left}px`; host.classList.add("is-positioned") }
  @HostListener("document:click") onDocumentClick() { this.dismissed.emit() }
}
