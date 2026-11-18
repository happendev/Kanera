import type { OnDestroy, OnInit } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, DestroyRef, Injectable, inject, input, output, signal } from "@angular/core";
import type { BoardInviteRow, BoardMemberAccessSource } from "@kanera/shared/dto";
import type { ServerToClientEvents, WireBoardMemberUser } from "@kanera/shared/events";
import { icu } from "../../core/i18n/icu";
import { appLocale } from "../../core/i18n/locale";
import { UnsavedWorkService } from "../../core/browser/unsaved-work.service";
import { ApiClient, ApiError } from "../../core/api/api.client";
import { AuthService } from "../../core/auth/auth.service";
import { ToastService } from "../../shared/toast.service";
import { SocketService, type AppSocket } from "../../core/realtime/socket.service";
import { ANCHORED_HOST_STYLES } from "../../shared/anchored-panel";
import { AnchoredPanelDirective } from "../../shared/anchored-panel.directive";
import { AvatarComponent } from "../../shared/avatar.component";
import { ConfirmService } from "../../shared/confirm.service";
import { copyToClipboard } from "../../shared/clipboard";
import { formatDate } from "../../shared/date-format";
import { SegmentedComponent, type SegmentedOption } from "../../shared/segmented.component";
import { UpgradePromptService } from "../../shared/upgrade-prompt.service";
import { TooltipDirective } from "../../shared/tooltip.directive";

type BoardRole = "editor" | "observer";
type BoardMemberCandidateRow = {
  userId: string; email: string; displayName: string; avatarUrl: string | null;
  lastOnlineAt?: string | Date | null; clientId: string;
  /** Someone outside the organisation who already holds another of its boards. */
  isGuest?: boolean;
};
type BoardMemberCandidatesResponse = { scope: "workspace" | "organisation"; members: BoardMemberCandidateRow[] };
export type BoardAccessMemberRow = {
  boardId: string; userId: string; role: BoardRole; assignedItemsOnly?: boolean; pinned: boolean; addedAt: string | Date;
  email: string; displayName: string; avatarUrl: string | null; lastOnlineAt?: string | Date | null; clientId: string;
  isOrganisationMember?: boolean; accessSource?: BoardMemberAccessSource;
};
type RenderedMemberRow = WireBoardMemberUser | BoardAccessMemberRow;
type CreatedInvite = { id: string; url: string; role: BoardRole; expiresAt: string };
type GuestSeatPreview = { paidGuestSeatRequired: boolean };
type GuestInvitationResult = { status: "added" | "invited" };

// Matches the settings page default, so a link made here lives as long as one made there.
const INVITE_EXPIRES_IN_DAYS = 7;
// Results under the search field stay a short pick list; typing narrows the rest.
const MAX_CANDIDATE_RESULTS = 6;
// Deliberately loose: the server validates the address. This only decides when to offer an invite.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const memberRoleRank: Record<string, number> = {
  owner: 0,
  admin: 0,
  editor: 1,
  member: 1,
  observer: 2,
};

// Read-only role badges; values are API role names.
const ROLE_LABELS: Record<string, string> = {
  owner: $localize`:Role badge:Owner`,
  admin: $localize`:Role badge:Admin`,
  editor: $localize`:Board role — can edit:Editor`,
  member: $localize`:Role badge:Member`,
  observer: $localize`:Board role — can view but not edit:Observer`,
};

function sortMembers<T extends RenderedMemberRow>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => {
    const aRank = a.pinned ? 0 : (memberRoleRank[a.role] ?? 99);
    const bRank = b.pinned ? 0 : (memberRoleRank[b.role] ?? 99);
    return aRank - bRank || a.displayName.localeCompare(b.displayName, appLocale(), { sensitivity: "base" });
  });
}

type BoardMembersSnapshot = {
  members: BoardAccessMemberRow[]; scope: "workspace" | "organisation"; roster: BoardMemberCandidateRow[]; invites: BoardInviteRow[];
};

/**
 * Last management view per viewer and board, so reopening the menu renders at once and revalidates
 * in the background. Keyed by viewer as well because the tab can outlive a sign-in. The server
 * still authorises every write, so a briefly stale row can only produce a rejected mutation.
 */
@Injectable({ providedIn: "root" })
class BoardMembersSnapshotCache {
  private readonly snapshots = new Map<string, BoardMembersSnapshot>();
  get(key: string) { return this.snapshots.get(key); }
  set(key: string, snapshot: BoardMembersSnapshot) { this.snapshots.set(key, snapshot); }
}

function errorBody(error: unknown): { code?: string; limit?: string; current?: number; message?: string } | undefined {
  return error instanceof ApiError ? error.body as { code?: string; limit?: string; current?: number; message?: string } | undefined : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return errorBody(error)?.message ?? error.message;
  return error instanceof Error ? error.message : $localize`Something went wrong.`;
}

/** The hosted Free tier refuses invite creation once the team fills every seat (see assertOrgMemberLimit). */
function memberLimitError(error: unknown): { current: number } | null {
  const body = errorBody(error);
  return body?.code === "PLAN_LIMIT" && body.limit === "members" ? { current: body.current ?? 0 } : null;
}

/** A plan without guests (hosted Free) refuses every guest grant; the upgrade prompt explains why. */
function guestsLimitError(error: unknown): boolean {
  const body = errorBody(error);
  return body?.code === "PLAN_LIMIT" && body.limit === "guests";
}

/** A guest's second board needs a purchased seat, and the pool is full (block-until-buy). */
function seatLimitError(error: unknown): boolean {
  return errorBody(error)?.code === "SEAT_LIMIT_REACHED";
}

function matchesQuery(query: string, row: { displayName: string; email?: string | null }) {
  return !query || row.displayName.toLocaleLowerCase(appLocale()).includes(query) || !!row.email?.toLowerCase().includes(query);
}

@Component({
  selector: "k-board-members-menu",
  standalone: true,
  imports: [AvatarComponent, NgTemplateOutlet, SegmentedComponent, TooltipDirective],
  hostDirectives: [AnchoredPanelDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bmp-panel">
      <!-- One field searches the roster and, for managers, finds people to add. An email address
           nobody here owns turns into an invitation, so a guest never needs a trip to settings. -->
      @if (showSearch()) {
        <div class="bmp-add" (focusout)="onAddFocusOut($event)">
          <div class="bmp-add-row" [class.is-manage]="canManage()">
            <label class="bmp-search">
              <i aria-hidden="true" class="ti ti-search"></i>
              @if (canManage()) {
                <input class="bmp-search-input" type="search" autocomplete="off" placeholder="Search or add people" i18n-placeholder="Placeholder of the board members search field for board managers; it also adds people" aria-label="Search or add people" i18n-aria-label="Placeholder of the board members search field for board managers; it also adds people" [value]="query()" (input)="query.set($any($event.target).value)" (focus)="addOpen.set(true)" (click)="addOpen.set(true)" (keydown.enter)="$event.preventDefault(); pickFirst()" [disabled]="busy()" />
              } @else {
                <input class="bmp-search-input" type="search" autocomplete="off" placeholder="Search members" i18n-placeholder aria-label="Search members" i18n-aria-label [value]="query()" (input)="query.set($any($event.target).value)" />
              }
            </label>
            @if (canManage()) {
              <span class="bmp-select-wrap bmp-add-role">
                <select aria-label="Role for people you add" i18n-aria-label="Select: board role given to people added or invited from the members menu" [value]="addRole()" (input)="addRole.set($any($event.target).value)" [disabled]="busy()">
                  <option value="editor" [selected]="addRole() === 'editor'" i18n="Board role: can edit">Editor</option>
                  <option value="observer" [selected]="addRole() === 'observer'" i18n="Board role: can view but not edit">Observer</option>
                </select>
                <i aria-hidden="true" class="ti ti-chevron-down"></i>
              </span>
            }
          </div>
          @if (showResults()) {
            <!-- mousedown keeps focus in the field, so picking a row doesn't first close the list. -->
            <div class="bmp-results" (mousedown)="$event.preventDefault()">
              @if (candidateMatches().length > 0) { <p class="bmp-results-title" i18n="Heading over the people a manager can add to the board from the members menu">Add to board</p> }
              @for (candidate of candidateMatches(); track candidate.userId) {
                <button class="bmp-result" type="button" (click)="addCandidate(candidate)" [disabled]="busy()">
                  <k-avatar [url]="candidate.avatarUrl" [name]="candidate.displayName" [size]="28" [userId]="candidate.userId" [workspaceId]="workspaceId()" />
                  <span class="bmp-person" [title]="candidate.email">
                    <span class="bmp-name">{{ candidate.displayName }}</span>
                    <!-- Names only, like the roster; an address appears only when it is the one way to
                         tell two people with the same name apart. -->
                    @if (sharedCandidateNames().has(candidate.displayName)) { <span class="bmp-email">{{ candidate.email }}</span> }
                  </span>
                  @if (candidate.isGuest) { <span class="bmp-tag" i18n="Badge: this person is a guest from outside the organisation">Guest</span> }
                  <span class="bmp-add-chip"><i aria-hidden="true" class="ti ti-plus"></i>&ngsp;<ng-container i18n="Button: add this person to the board">Add</ng-container></span>
                </button>
              }
              @if (inviteEmail(); as email) {
                <button class="bmp-result" type="button" (click)="inviteGuest(email)" [disabled]="busy()">
                  <span class="bmp-result-icon"><i aria-hidden="true" class="ti ti-mail-plus"></i></span>
                  <span class="bmp-person">
                    <span class="bmp-name" i18n="Option: invite someone outside the organisation to this board by email">Invite {{ email // i18n(ph="email") }} as a guest</span>
                    <span class="bmp-email" i18n>They see only the boards you share with them.</span>
                  </span>
                </button>
                @if (canInvite()) {
                  <button class="bmp-result" type="button" (click)="inviteMember(email)" [disabled]="busy() || addAssignedItemsOnly()">
                    <span class="bmp-result-icon"><i aria-hidden="true" class="ti ti-user-plus"></i></span>
                    <span class="bmp-person">
                      <span class="bmp-name" i18n="Option: invite someone by email to join the organisation with access to this board">Invite {{ email // i18n(ph="email") }} to your organisation</span>
                      @if (addAssignedItemsOnly()) { <span class="bmp-email" i18n>Organisation members see the whole board.</span> }
                      @else { <span class="bmp-email" i18n>They join as an organisation member.</span> }
                    </span>
                  </button>
                }
              }
              @if (candidateMatches().length === 0 && !inviteEmail()) {
                @if (normalizedQuery()) { <p class="bmp-empty" i18n>No one matches. Enter an email address to invite someone.</p> }
                @else { <p class="bmp-empty" i18n="Shown under the empty board members search when nobody else can be added by name">Everyone you can add is already on this board. Enter an email address to invite someone.</p> }
              }
              @if (moreCandidatesHint(); as hint) { <p class="bmp-more">{{ hint }}</p> }
              @if (candidateMatches().length > 0 || inviteEmail()) {
                <!-- Inside the box: it applies to whoever is added from it, not to the roster below. -->
                <label class="bmp-restrict bmp-results-restrict">
                  <input type="checkbox" [checked]="addAssignedItemsOnly()" (input)="addAssignedItemsOnly.set($any($event.target).checked)" [disabled]="busy()" />
                  <span i18n="Toggle: restrict a board member to cards assigned to them">Assigned items only</span>
                </label>
              }
            </div>
          }
        </div>
      }
      @if (error()) { <p class="bmp-error" role="alert"><i aria-hidden="true" class="ti ti-alert-circle"></i><span>{{ error() }}</span></p> }
      @if (loading() && renderedMembers().length === 0) { <p class="bmp-empty"><i aria-hidden="true" class="ti ti-loader-2 spin"></i> <ng-container i18n>Loading members…</ng-container></p> }
      @else {
        <!-- The roster is the part that scrolls: the search above and the footer below stay in view. -->
        <div class="bmp-list k-scroll-fade">
          @if (admins().length > 0) {
            <section class="bmp-section">
              <div class="bmp-section-title" i18n="Section heading: people who always have access to every board through their admin role">Admins</div>
              @for (member of admins(); track member.userId) {
                <div class="bmp-row">
                  <div class="bmp-identity">
                    <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [size]="30" [userId]="member.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="member.lastOnlineAt ?? null" />
                    <div class="bmp-person">
                      <span class="bmp-name" [title]="member.displayName">{{ member.displayName }}</span>
                      <span class="bmp-email">@if (member.userId === currentUserId()) { <ng-container i18n="Badge next to the current user's own name">You</ng-container> · }{{ adminReason(member) }}</span>
                    </div>
                  </div>
                  <span class="bmp-role bmp-role-admin" tabindex="0" [kTooltip]="adminHint(member)"><i aria-hidden="true" class="ti ti-shield"></i>&ngsp;<ng-container i18n="Role badge">Admin</ng-container></span>
                </div>
              }
            </section>
          }
          <!-- While searching, empty sections drop out; managers get the add results above instead. -->
          @if (localMembers().length > 0 || (!normalizedQuery() && admins().length === 0 && guests().length === 0)) {
            <section class="bmp-section">
              <div class="bmp-section-title" i18n="Section heading: board members">Members</div>
              @for (member of localMembers(); track member.userId) {
                <ng-container [ngTemplateOutlet]="memberRow" [ngTemplateOutletContext]="{ $implicit: member }" />
              } @empty { <p class="bmp-empty" i18n>No board members</p> }
            </section>
          }
          @if (!canManage() && normalizedQuery() && !rosterHasMatches()) { <p class="bmp-empty" i18n>No members match.</p> }
          @if (guests().length > 0) {
            <section class="bmp-section bmp-guests">
              <div class="bmp-section-title" i18n="Section heading: board members from other organisations">Guests</div>
              @for (guest of guests(); track guest.userId) {
                <ng-container [ngTemplateOutlet]="memberRow" [ngTemplateOutletContext]="{ $implicit: guest }" />
              }
            </section>
          }
          @if (visibleInvites().length > 0) {
            <section class="bmp-section bmp-invites">
              <div class="bmp-section-title" i18n="Settings section heading">Pending invites</div>
              @for (invite of visibleInvites(); track invite.kind + invite.id) {
                <div class="bmp-row">
                  <div class="bmp-identity">
                    <span class="bmp-invite-avatar"><i aria-hidden="true" [class]="invite.email ? 'ti ti-mail' : 'ti ti-link'"></i></span>
                    <div class="bmp-person">
                      @if (invite.email) { <span class="bmp-name bmp-invite-email" [title]="invite.email">{{ invite.email }}</span> }
                      @else { <span class="bmp-name bmp-invite-email" i18n>Invite link</span> }
                      <span class="bmp-email">{{ inviteSummary(invite) }}</span>
                    </div>
                  </div>
                  @if (canRevoke(invite)) {
                    <button class="bmp-icon-btn bmp-revoke" type="button" (click)="revokeInvite(invite)" [disabled]="busy()" [attr.aria-label]="revokeLabel(invite)" [kTooltip]="revokeLabel(invite)"><i aria-hidden="true" class="ti ti-x"></i></button>
                  }
                </div>
              }
            </section>
          }
        </div>
        <!-- Invite links mint organisation members, so they stay with organisation admins and sit
             apart from the guest-first search above. -->
        @if (canInvite() && !loading()) {
          <div class="bmp-footer bmp-invite">
            @if (createdInvite(); as invite) {
              <div class="bmp-invite-link">
                <input class="bmp-invite-url" type="text" readonly [value]="invite.url" aria-label="Invite link" i18n-aria-label="Accessible name of the read-only field holding a new invite link" (focus)="$any($event.target).select()" />
                <button class="bmp-invite-copy" type="button" (click)="copyInviteLink()" aria-label="Copy invite link" i18n-aria-label>
                  @if (inviteCopied()) { <i aria-hidden="true" class="ti ti-check"></i> <span i18n="Button state after copying">Copied</span> }
                  @else { <i aria-hidden="true" class="ti ti-copy"></i> <span i18n="Button: copy to clipboard">Copy</span> }
                </button>
              </div>
              <p class="bmp-invite-hint"><i aria-hidden="true" class="ti ti-shield-check"></i> <span>{{ inviteHint(invite) }}</span></p>
            } @else {
              <div class="bmp-invite-row">
                <span class="bmp-select-wrap">
                  <select class="bmp-invite-role" aria-label="Role for people who join with the link" i18n-aria-label="Select: board role an invite link grants" [value]="inviteRole()" (input)="inviteRole.set($any($event.target).value)" [disabled]="busy()">
                    <option value="editor" [selected]="inviteRole() === 'editor'" i18n="Board role: can edit">Editor</option>
                    <option value="observer" [selected]="inviteRole() === 'observer'" i18n="Board role: can view but not edit">Observer</option>
                  </select>
                  <i aria-hidden="true" class="ti ti-chevron-down"></i>
                </span>
                <button class="bmp-invite-create" type="button" (click)="createInvite()" [disabled]="busy()">
                  <i aria-hidden="true" [class]="inviting() ? 'ti ti-loader-2 kanera-spin' : 'ti ti-link'"></i>
                  <span i18n="Button: create an invite link that grants this board">Invite by link</span>
                </button>
              </div>
            }
            @if (inviteError(); as message) { <p class="bmp-error" role="alert"><i aria-hidden="true" class="ti ti-alert-circle"></i><span>{{ message }}</span></p> }
          </div>
        }
        @if (leavingMember(); as member) {
          <div class="bmp-footer">
            <button class="bmp-leave" type="button" (click)="leaveMembership(member)" [disabled]="busy() || confirmingRemoval()">
              <i class="ti ti-logout" aria-hidden="true"></i>
              <span i18n="Button: leave this board">Leave board</span>
            </button>
          </div>
        }
      }
    </div>

    <ng-template #memberRow let-member>
      <div class="bmp-member" [class.is-open]="openAccessId() === member.userId">
        <div class="bmp-row">
          <div class="bmp-identity">
            <k-avatar [url]="member.avatarUrl" [name]="member.displayName" [size]="30" [userId]="member.userId" [workspaceId]="workspaceId()" [showPresence]="true" [lastOnlineAt]="member.lastOnlineAt ?? null" />
            <div class="bmp-person">
              <!-- The roster names people; the address is on hover only. -->
              <span class="bmp-name" [title]="isAccessRow(member) && member.email ? member.email : member.displayName">{{ member.displayName }}</span>
              @if (member.assignedItemsOnly) {
                <span class="bmp-email bmp-restricted"><i aria-hidden="true" class="ti ti-lock"></i>&ngsp;<ng-container i18n="Toggle: restrict a board member to cards assigned to them">Assigned items only</ng-container></span>
              } @else if (member.userId === currentUserId()) { <span class="bmp-email" i18n="Badge next to the current user's own name">You</span> }
            </div>
          </div>
          @if (canManage() && isAccessRow(member)) {
            <!-- Removing gets its own visible button: tucked inside the role control, people could
                 not find it. The role control keeps only what changes the role. -->
            <div class="bmp-row-actions">
              <button class="bmp-access" type="button" [attr.aria-expanded]="openAccessId() === member.userId" [attr.aria-label]="roleForLabel(member.displayName)" (click)="toggleAccess(member.userId)" [disabled]="busy()">
                <span>{{ roleLabel(member.role) }}</span><i aria-hidden="true" class="ti ti-chevron-down"></i>
              </button>
              <button class="bmp-icon-btn bmp-remove" type="button" (click)="removeMember(member)" [disabled]="busy()" [attr.aria-label]="removeLabel(member.displayName)" [kTooltip]="removeLabel(member.displayName)"><i aria-hidden="true" class="ti ti-user-minus"></i></button>
            </div>
          } @else {
            <span class="bmp-role">{{ roleLabel(member.role) }}</span>
          }
        </div>
        @if (canManage() && isAccessRow(member) && openAccessId() === member.userId) {
          <!-- Inline rather than a nested menu: one floating layer, and it works the same on a phone. -->
          <div class="bmp-access-panel">
            <k-segmented [options]="roleOptions" [value]="member.role" [showLabels]="true" [equalWidths]="true" [ariaLabel]="roleForLabel(member.displayName)" (valueChange)="changeRole(member.userId, $event)" />
            <label class="bmp-restrict" [kTooltip]="assignedItemsOnlyTooltip(!!member.assignedItemsOnly)">
              <input type="checkbox" [checked]="!!member.assignedItemsOnly" (input)="changeRestriction(member, $any($event.target).checked)" [disabled]="busy()" [attr.aria-label]="assignedOnlyForLabel(member.displayName)" />
              <span i18n="Toggle: restrict a board member to cards assigned to them">Assigned items only</span>
            </label>
          </div>
        }
      </div>
    </ng-template>
  `,
  styles: [
    ANCHORED_HOST_STYLES,
    `
    .bmp-panel{width:100%;max-height:var(--ap-max-height,720px);overflow:hidden;display:flex;flex-direction:column;gap:10px;padding:12px;background:var(--surface-overlay);border:1px solid var(--overlay-border);border-radius:var(--radius-md);box-shadow:var(--shadow-pop)}
    .bmp-panel > *{flex:none}
    /* Takes whatever height the placement leaves after the search and footer. It reaches through the
       panel's side and bottom padding so the last row scrolls clear of the border and the scroll cue
       spans the full width. */
    .bmp-panel > .bmp-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;margin:0 -12px -12px;padding:0 12px 12px;--k-scroll-fade-pad:12px;--k-scroll-fade-gap:10px}
    /* A footer below takes the panel's bottom edge, so the list stops short of it. */
    .bmp-panel > .bmp-list:has(+ .bmp-footer){margin-bottom:0;padding-bottom:0}
    .bmp-add{display:flex;flex-direction:column;gap:6px}
    .bmp-add-row{display:grid;grid-template-columns:minmax(0,1fr);gap:6px}
    .bmp-add-row.is-manage{grid-template-columns:minmax(0,1fr) 112px}
    /* Controls sit on floating chrome, so they take --overlay-border: --border is nearly the overlay
       fill on dark and left them with no visible edge. */
    .bmp-search{position:relative;display:block;min-width:0}
    .bmp-search > i{position:absolute;top:50%;left:9px;transform:translateY(-50%);color:var(--text-muted);font-size:var(--text-md);pointer-events:none}
    .bmp-search input.bmp-search-input{width:100%;min-width:0;height:var(--h-lg);padding:0 9px 0 30px;border:1px solid var(--overlay-border);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);font-size:var(--text-sm);outline:0}
    .bmp-search input.bmp-search-input:focus-visible{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}
    /* Selects draw their own Tabler chevron: the native arrow differed per OS and crowded the label. */
    .bmp-select-wrap{position:relative;display:block;min-width:0}
    .bmp-select-wrap > i{position:absolute;top:50%;right:8px;transform:translateY(-50%);color:var(--text-muted);font-size:var(--text-sm);pointer-events:none}
    .bmp-select-wrap:has(select:disabled) > i{opacity:.55}
    .bmp-select-wrap select{appearance:none;width:100%;min-width:0;height:var(--h-lg);padding:0 26px 0 9px;border:1px solid var(--overlay-border);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);font-size:var(--text-sm);outline:0;cursor:pointer}
    .bmp-select-wrap select:focus-visible{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}
    .bmp-invite-row .bmp-select-wrap select{height:var(--h-md)}
    .bmp-results{display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--overlay-border);border-radius:var(--radius-sm)}
    /* Row buttons: reset the global button height, accent fill and centring. */
    .bmp-result{flex:none;display:flex;align-items:center;gap:8px;width:100%;height:auto;min-height:40px;padding:5px 6px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--text);font:inherit;text-align:left;justify-content:flex-start;cursor:pointer}
    .bmp-result:hover:not(:disabled),.bmp-result:focus-visible{background:var(--surface-hover);color:var(--text)}
    .bmp-result-icon{display:inline-flex;flex:none;width:28px;height:28px;align-items:center;justify-content:center;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:var(--text-md)}
    .bmp-results-title{margin:0;padding:4px 6px 2px;color:var(--text-3);font-size:var(--text-xs);font-weight:600}
    /* Always visible, in the accent: these rows are actions, and must not read as more roster. */
    .bmp-add-chip{display:inline-flex;flex:none;align-items:center;gap:4px;height:var(--h-xs);padding:0 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:var(--text-xs);font-weight:600}
    .bmp-add-chip i{font-size:var(--text-sm)}
    .bmp-more{margin:0;padding:4px 6px;color:var(--text-muted);font-size:var(--text-xs);text-wrap:pretty}
    .bmp-results-restrict{flex:none;margin-top:2px;padding:4px 6px 2px}
    .bmp-tag{flex:none;padding:1px 7px;border:1px solid var(--overlay-border);border-radius:999px;color:var(--text-3);font-size:var(--text-xs)}
    .bmp-restrict{display:flex;align-items:center;gap:8px;padding:2px 6px;color:var(--text-3);font-size:var(--text-sm);cursor:pointer}
    .bmp-restrict input{width:16px;height:16px;flex:none;margin:0;accent-color:var(--accent)}
    /* The global checkbox edge is --border, which all but vanishes on the overlay's hover wash. */
    .bmp-restrict input:not(:checked){border-color:var(--text-4)}
    button:disabled,select:disabled,input:disabled{cursor:not-allowed;opacity:.55}
    .bmp-section{display:flex;flex-direction:column;gap:2px}
    .bmp-guests,.bmp-invites{padding-top:8px;border-top:1px solid var(--overlay-separator)}
    /* The .k-menu-heading recipe, inset to the rows' avatar edge. */
    .bmp-section-title{padding:4px 6px;color:var(--text-3);font-size:var(--text-xs);font-weight:600}
    .bmp-member{flex:none;border-radius:var(--radius-sm)}
    .bmp-member.is-open{background:var(--surface-hover)}
    .bmp-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;min-height:44px;padding:6px;border-radius:var(--radius-sm)}
    .bmp-member:not(.is-open) > .bmp-row:hover,.bmp-section > .bmp-row:hover{background:var(--surface-hover)}
    .bmp-identity{display:flex;min-width:0;align-items:center;gap:8px}
    .bmp-person{display:flex;min-width:0;flex:1;flex-direction:column;gap:1px}
    .bmp-name,.bmp-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .bmp-name{color:var(--text);font-size:var(--text-base);font-weight:600}
    .bmp-invite-email{font-weight:500}
    .bmp-email{color:var(--text-muted);font-size:var(--text-xs)}
    .bmp-restricted{color:var(--accent)}
    .bmp-role{color:var(--text-muted);font-size:var(--text-xs);font-weight:600;white-space:nowrap}
    /* Outlined rather than filled: --surface-3 all but vanished on the dark overlay. */
    .bmp-role-admin{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--overlay-border);border-radius:999px;background:transparent;outline:0}
    .bmp-role-admin:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 25%,transparent)}
    /* One quiet control per row instead of a select, a lock and a bin: the list reads as people. */
    .bmp-access{display:inline-flex;align-items:center;justify-content:space-between;gap:6px;min-width:92px;height:var(--h-sm);padding:0 8px 0 10px;border:1px solid var(--overlay-border);border-radius:var(--radius-sm);background:transparent;color:var(--text-3);font:inherit;font-size:var(--text-sm);cursor:pointer;transition:background var(--motion-fast),color var(--motion-fast),border-color var(--motion-fast)}
    .bmp-access i{font-size:var(--text-sm);color:var(--text-muted);transition:transform var(--dur)}
    .bmp-access:hover:not(:disabled){background:var(--surface-2);color:var(--text)}
    .bmp-access[aria-expanded="true"]{border-color:color-mix(in srgb,var(--accent) 45%,var(--overlay-border));background:var(--surface-2);color:var(--text)}
    .bmp-access[aria-expanded="true"] i{transform:rotate(180deg)}
    .bmp-access-panel{display:flex;flex-direction:column;gap:6px;padding:2px 6px 8px 44px}
    .bmp-access-panel .bmp-restrict{padding:2px 0}
    .bmp-row-actions{display:flex;align-items:center;gap:2px}
    .bmp-remove:hover:not(:disabled),.bmp-remove:focus-visible{background:var(--danger-soft);color:var(--danger)}
    .bmp-invite-avatar{display:inline-flex;flex:none;width:30px;height:30px;align-items:center;justify-content:center;border:1px dashed var(--overlay-border);border-radius:999px;color:var(--text-muted);font-size:var(--text-md)}
    .bmp-icon-btn{display:inline-flex;flex:none;width:var(--h-md);height:var(--h-md);padding:0;align-items:center;justify-content:center;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--text-muted);font-size:var(--text-md);cursor:pointer}
    .bmp-revoke:hover:not(:disabled),.bmp-revoke:focus-visible{background:var(--danger-soft);color:var(--danger)}
    .bmp-footer{flex:none;padding-top:8px;border-top:1px solid var(--overlay-separator)}
    .bmp-leave{display:flex;align-items:center;justify-content:flex-start;gap:8px;width:100%;height:auto;min-height:34px;padding:7px 8px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--danger);font:inherit;font-size:var(--text-sm);text-align:left;cursor:pointer}
    .bmp-leave i{font-size:var(--text-lg)}
    .bmp-leave:not(:disabled):hover{background:var(--danger-soft);color:var(--danger)}
    .bmp-leave:focus-visible{outline:2px solid var(--danger);outline-offset:2px}
    .bmp-invite{display:flex;flex-direction:column;gap:8px}
    .bmp-invite-row,.bmp-invite-link{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}
    /* Secondary actions: outlined, so the accent flood of the global button reset never applies. */
    .bmp-invite-create,.bmp-invite-copy{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--h-md);padding:0 10px;border:1px solid var(--overlay-border);border-radius:var(--radius-sm);background:transparent;color:var(--text);font:inherit;font-size:var(--text-sm);font-weight:500;white-space:nowrap;cursor:pointer}
    .bmp-invite-create:hover:not(:disabled),.bmp-invite-copy:hover:not(:disabled){background:var(--surface-hover);color:var(--text)}
    .bmp-invite-create i,.bmp-invite-copy i{font-size:var(--text-md)}
    .bmp-invite-copy .ti-check{color:var(--success)}
    /* The token is long and opaque: the field truncates and copying is the real affordance; focus
       selects the whole link for a manual copy where the clipboard API is unavailable. */
    .bmp-invite-link input.bmp-invite-url{width:100%;min-width:0;height:var(--h-md);padding:0 9px;border:1px solid var(--overlay-border);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text-3);font-size:var(--text-sm);text-overflow:ellipsis}
    .bmp-invite-hint{display:flex;align-items:flex-start;gap:6px;margin:0;padding:0 6px;color:var(--text-muted);font-size:var(--text-xs);text-wrap:pretty}
    .bmp-invite-hint i{flex:none;font-size:var(--text-sm)}
    .bmp-empty{margin:0;padding:6px;color:var(--text-muted);font-size:var(--text-sm)}
    .bmp-error{display:flex;align-items:flex-start;gap:6px;margin:0;padding:6px 8px;border-radius:var(--radius-sm);background:var(--danger-soft);color:var(--danger);font-size:var(--text-sm);line-height:1.4}
    .bmp-error i{flex:none;font-size:var(--text-md);line-height:1.25}
    /* Server messages are lower-case fragments; a sentence reads better as a callout. */
    .bmp-error span{min-width:0;overflow-wrap:anywhere}
    .bmp-error span::first-letter{text-transform:uppercase}
    /* Touch: 44px targets. Rows carry a single control now, so they stay on one line at phone width. */
    @media (hover: none), (pointer: coarse), (any-pointer: coarse) {
      .bmp-search input.bmp-search-input,.bmp-select-wrap select,.bmp-invite-row .bmp-select-wrap select{height:44px}
      .bmp-result{min-height:44px}
      .bmp-access{height:44px}
      .bmp-restrict{min-height:44px}
      .bmp-icon-btn{height:44px}
      .bmp-icon-btn{width:44px}
      .bmp-leave{min-height:44px}
      .bmp-invite-link input.bmp-invite-url,.bmp-invite-create,.bmp-invite-copy{height:44px}
    }
  `,
  ],
})
// The product-facing name intentionally mirrors the selector; this is a menu that uses popover positioning.
// eslint-disable-next-line @angular-eslint/component-class-suffix
export class BoardMembersMenu implements OnInit, OnDestroy {
  private readonly panel = inject(AnchoredPanelDirective);
  private readonly api = inject(ApiClient);
  private readonly unsavedWork = inject(UnsavedWorkService);
  private readonly confirm = inject(ConfirmService);
  private readonly toasts = inject(ToastService);
  private readonly auth = inject(AuthService);
  private readonly upgradePrompt = inject(UpgradePromptService);
  /** The deferred removal usually completes after the popover has closed; see removeMember. */
  private destroyed = false;
  private readonly sockets = inject(SocketService);
  private readonly snapshots = inject(BoardMembersSnapshotCache);
  /** Whether accessMembers/roster hold this board's management data (cached or fetched). */
  private readonly accessLoaded = signal(false);
  readonly boardId = input.required<string>(); readonly workspaceId = input<string | null>(null); readonly ownerClientId = input<string | null>(null); readonly boardRoomManaged = input(false);
  readonly currentUserId = input<string | null>(null); readonly canManage = input(false); readonly members = input<WireBoardMemberUser[]>([]); readonly dismissed = output<void>(); readonly memberAdded = output<WireBoardMemberUser>(); readonly memberRemoved = output<string>();
  readonly accessMembers = signal<BoardAccessMemberRow[]>([]); readonly roster = signal<BoardMemberCandidateRow[]>([]); readonly invites = signal<BoardInviteRow[]>([]); readonly candidateScope = signal<"workspace" | "organisation">("workspace"); readonly loading = signal(false); readonly busy = signal(false); readonly confirmingRemoval = signal(false); readonly error = signal<string | null>(null); readonly addRole = signal<BoardRole>("editor"); readonly addAssignedItemsOnly = signal(false);
  readonly query = signal("");
  /** The member whose access controls are expanded; one at a time keeps the list scannable. */
  readonly openAccessId = signal<string | null>(null);
  readonly roleOptions: readonly SegmentedOption<BoardRole>[] = [
    { id: "editor", icon: "pencil", label: $localize`:Board role — can edit:Editor` },
    { id: "observer", icon: "eye", label: $localize`:Board role — can view but not edit:Observer` },
  ];
  // Until the management rows arrive, show the roster the board page already holds (read-only) rather
  // than a spinner; the role controls appear once the authoritative rows are in.
  readonly renderedMembers = computed<RenderedMemberRow[]>(() => this.canManage() && this.accessLoaded() ? this.accessMembers() : this.members());
  readonly leavingMember = computed(() => this.renderedMembers().find(member => this.canLeave(member)) ?? null);
  readonly normalizedQuery = computed(() => this.query().trim().toLocaleLowerCase(appLocale()));
  private readonly filteredMembers = computed(() => {
    const query = this.normalizedQuery();
    return this.renderedMembers().filter((member) => matchesQuery(query, { displayName: member.displayName, email: "email" in member ? member.email : null }));
  });
  // Pinned rows are admins whose access comes from their workspace or organisation role, so they are
  // grouped apart and carry no controls: changing them happens where that role is managed.
  readonly admins = computed(() => sortMembers(this.filteredMembers().filter((m) => m.pinned)));
  readonly localMembers = computed(() => {
    const rows = this.filteredMembers().filter((m) => !m.pinned);
    // Until the board owner's organisation is known, everyone stays under Members.
    if (!this.ownerClientId()) return sortMembers(rows);
    return sortMembers(rows.filter((m) => m.isOrganisationMember));
  });
  readonly guests = computed(() => {
    if (!this.ownerClientId()) return [];
    return sortMembers(this.filteredMembers().filter((m) => !m.pinned && !m.isOrganisationMember));
  });
  readonly rosterHasMatches = computed(() => this.filteredMembers().length > 0);
  readonly visibleInvites = computed(() => {
    if (!this.canManage()) return [];
    const query = this.normalizedQuery();
    return this.invites().filter((invite) => !query || !!invite.email?.toLowerCase().includes(query));
  });
  /** Managers always get the field (it is how people are added); everyone else once the list is long. */
  readonly showSearch = computed(() => this.canManage() || this.members().length > 8);
  /**
   * Organisation invites are owner/admin only (the API enforces it) and are created in the viewer's
   * active organisation, so the action only appears on that organisation's boards: a workspace admin
   * who is a plain organisation member, or an admin looking at another organisation's board, would
   * only get a rejection. Guest invitations need only workspace admin, so they are offered to every
   * manager.
   */
  readonly canInvite = computed(() => {
    const user = this.auth.user();
    if (!user || !this.canManage() || !this.auth.isOrgAdmin()) return false;
    const owner = this.ownerClientId();
    return !owner || owner === (user.activeClientId ?? user.clientId);
  });
  readonly inviteRole = signal<BoardRole>("editor"); readonly inviting = signal(false); readonly inviteError = signal<string | null>(null); readonly createdInvite = signal<CreatedInvite | null>(null); readonly inviteCopied = signal(false);
  readonly candidates = computed(() => {
    // A reopened menu starts from its cached snapshot, which misses anyone added while it was
    // closed; the board page's roster is kept live by realtime. Either one rules a person out, since
    // offering someone already on the board only earns a rejection.
    const present = new Set([...this.accessMembers(), ...this.members()].map((m) => m.userId));
    return this.roster()
      .filter((m) => !present.has(m.userId))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, appLocale(), { sensitivity: "base" }));
  });
  readonly sharedCandidateNames = computed(() => {
    const seen = new Set<string>(); const shared = new Set<string>();
    for (const { displayName } of this.candidates()) (seen.has(displayName) ? shared : seen).add(displayName);
    return shared;
  });
  /** True while the search field (or a control beside it) has focus. */
  readonly addOpen = signal(false);
  readonly candidateMatches = computed(() => {
    const query = this.normalizedQuery();
    // An empty, focused field lists everyone who can be added, so managers can browse rather than
    // having to know a name first.
    if (!query) return this.addOpen() ? this.candidates().slice(0, MAX_CANDIDATE_RESULTS) : [];
    return this.candidatePool().slice(0, MAX_CANDIDATE_RESULTS);
  });
  private readonly candidatePool = computed(() => {
    const query = this.normalizedQuery();
    return query ? this.candidates().filter((candidate) => matchesQuery(query, candidate)) : this.candidates();
  });
  /**
   * The list shows a handful; an organisation can have hundreds of people. Rather than a long scroll
   * nobody reads, say how many more there are and that typing finds them.
   */
  readonly moreCandidatesHint = computed(() => {
    const hidden = this.candidatePool().length - this.candidateMatches().length;
    if (hidden <= 0 || this.candidateMatches().length === 0) return null;
    return this.normalizedQuery()
      ? icu($localize`:Under the add list in the board members menu when more people match than are shown:{count, plural, one {# more person matches. Keep typing to narrow it down.} other {# more people match. Keep typing to narrow it down.}}`, { count: hidden })
      : icu($localize`:Under the add list in the board members menu when more people can be added than are shown:{count, plural, one {Type a name or email to find # more person.} other {Type a name or email to find # more people.}}`, { count: hidden });
  });
  readonly showResults = computed(() => {
    if (!this.canManage()) return false;
    if (!this.normalizedQuery()) return this.addOpen() && this.accessLoaded();
    return this.candidateMatches().length > 0 || !!this.inviteEmail() || !this.rosterHasMatches();
  });
  /**
   * The typed address when it belongs to nobody the menu already knows: an existing person is added
   * from their result row (or is already listed), and an address with a pending invite shows that
   * invite instead of offering a duplicate the server would refuse.
   */
  readonly inviteEmail = computed(() => {
    const email = this.query().trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return null;
    const known = [...this.roster(), ...this.accessMembers()].some((row) => row.email.toLowerCase() === email)
      || this.invites().some((invite) => invite.email?.toLowerCase() === email);
    return known ? null : email;
  });
  private socket: AppSocket | null = null; private leaveBoard?: () => void;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; });
    this.panel.configure({
      // Wide enough that a name, an email and the access button share a row without truncating
      // every address. Placement still clamps it on phones.
      // maxHeight is a ceiling, not the size: the viewport clamp decides, so a phone uses its height.
      placement: () => ({ width: 360, maxHeight: 720 }),
      // An outside click during a removal confirmation must not tear the popover down: the DELETE is
      // still in flight and its success output has to reach the board page. Escape can dismiss the
      // confirmation stage, but an active write must keep its success/error handler mounted.
      // Escape closes an open add list (or clears the search) before it closes the menu. The panel
      // stack takes Escape in the capture phase, so the field itself never sees the key.
      canDismiss: (reason) => {
        if (reason === "escape" && this.closeAddList()) return false;
        return !this.busy() && (reason === "escape" || !this.confirmingRemoval());
      },
      onDismiss: () => this.dismissed.emit(),
    });
  }


  async ngOnInit() {
    if (!this.canManage()) return;
    this.socket = this.sockets.connect();
    // The board page already owns this room for its full route lifetime. Only acquire a room
    // reference when the menu is rendered elsewhere (currently workspace settings), otherwise
    // destroying this short-lived popover can eject the board page before a durable event arrives.
    if (!this.boardRoomManaged()) this.leaveBoard = this.sockets.joinBoard(this.boardId());
    this.socket.on("board:member:added", this.onMemberUpsert); this.socket.on("board:member:updated", this.onMemberUpsert); this.socket.on("board:member:removed", this.onMemberRemoved); this.socket.on("client:user:role-changed", this.onClientUserRoleChanged);
    const cached = this.snapshots.get(this.snapshotKey());
    if (cached) { this.accessMembers.set(cached.members); this.candidateScope.set(cached.scope); this.roster.set(cached.roster); this.invites.set(cached.invites); this.accessLoaded.set(true); }
    await this.reload(!cached);
  }
  ngOnDestroy() { if (this.accessLoaded()) this.snapshots.set(this.snapshotKey(), { members: this.accessMembers(), scope: this.candidateScope(), roster: this.roster(), invites: this.invites() }); this.socket?.off("board:member:added", this.onMemberUpsert); this.socket?.off("board:member:updated", this.onMemberUpsert); this.socket?.off("board:member:removed", this.onMemberRemoved); this.socket?.off("client:user:role-changed", this.onClientUserRoleChanged); this.leaveBoard?.() }
  isAccessRow(member: WireBoardMemberUser | BoardAccessMemberRow): member is BoardAccessMemberRow { return "addedAt" in member; }
  roleLabel(role: string) { return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1) }
  roleForLabel(name: string) { return $localize`:Accessible name of a member's role select:Role for ${name}:name:`; }
  assignedOnlyForLabel(name: string) { return $localize`:Accessible name of the assigned-items-only toggle for a member:Assigned items only for ${name}:name:`; }
  removeLabel(name: string) { return $localize`:Accessible name of a button removing a member from the board:Remove ${name}:name:`; }
  assignedItemsOnlyTooltip(restricted: boolean) { return restricted ? $localize`Restricted to assigned cards — click to allow access to every card on this board.` : $localize`Access to all cards — click to show only cards assigned directly or through a checklist item.` }
  toggleAccess(userId: string) { this.openAccessId.update((open) => open === userId ? null : userId); }

  /** Why an admin has access, from the management rows; the board roster only knows they are pinned. */
  adminReason(member: RenderedMemberRow): string {
    const source = "accessSource" in member ? member.accessSource : null;
    switch (source) {
      case "organisation_owner": return $localize`:Why a board admin has access - they own the organisation:Organisation owner`;
      case "organisation_admin": return $localize`:Why a board admin has access - they are an organisation admin:Organisation admin`;
      case "workspace_admin": return $localize`:Role badge on a profile card:Workspace admin`;
      default: return ROLE_LABELS["admin"]!;
    }
  }
  adminHint(member: RenderedMemberRow): string {
    const source = "accessSource" in member ? member.accessSource : null;
    return source === "workspace_admin"
      ? $localize`Admins have access to every board. Change their role in workspace settings.`
      : source ? $localize`Admins have access to every board. Change their role in organisation settings.`
      : $localize`Admins have access to every board.`;
  }

  inviteSummary(invite: BoardInviteRow): string {
    const kind = invite.kind === "guest"
      ? $localize`:Pending invite kind - for someone outside the organisation:Guest invite`
      : $localize`:Pending invite kind - to join the organisation:Member invite`;
    const parts = [kind, this.roleLabel(invite.role)];
    if (invite.expiresAt) {
      const date = formatDate(invite.expiresAt, "short", { timeZone: this.auth.user()?.timezone });
      parts.push($localize`:Pending invite expiry in the board members menu; the placeholder is a short date:Expires ${date}:date:`);
    }
    return parts.join(" · ");
  }
  canRevoke(invite: BoardInviteRow) { return invite.kind === "guest" || this.auth.isOrgAdmin(); }
  revokeLabel(invite: BoardInviteRow) {
    return invite.email
      ? $localize`:Accessible name of a button withdrawing a pending invite:Withdraw invite for ${invite.email}:email:`
      : $localize`:Accessible name of a button withdrawing a pending invite link:Withdraw invite link`;
  }

  /** Enter adds the first match, or sends the guest invitation when only an address was typed. */
  pickFirst() {
    // With nothing typed the list is for browsing; Enter must not add whoever sorts first.
    if (!this.normalizedQuery()) return;
    const first = this.candidateMatches()[0];
    if (first) { void this.addCandidate(first); return; }
    const email = this.inviteEmail();
    if (email) void this.inviteGuest(email);
  }

  async addCandidate(candidate: BoardMemberCandidateRow) {
    if (this.busy()) return;
    this.busy.set(true); this.error.set(null);
    try {
      const role = this.addRole(); const assignedItemsOnly = this.addAssignedItemsOnly();
      if (candidate.isGuest && !await this.confirmGuestSeat(candidate.email, role, assignedItemsOnly)) return;
      await this.api.post(`/boards/${this.boardId()}/members`, { userId: candidate.userId, role, assignedItemsOnly });
      this.resetAddForm();
      await this.reload(false);
      this.emitAdded(candidate.userId);
    } catch (e) {
      // Someone else may have added them while this list was open. If a refresh shows them on the
      // board, the add already has what it wanted, so no error.
      await this.reload(false);
      if (this.accessMembers().some((row) => row.userId === candidate.userId)) { this.resetAddForm(); this.emitAdded(candidate.userId); return; }
      await this.showGrantError(e);
    } finally { this.busy.set(false) }
  }

  private emitAdded(userId: string) {
    const added = this.accessMembers().find((row) => row.userId === userId);
    if (added) this.memberAdded.emit({ userId: added.userId, displayName: added.displayName, avatarUrl: added.avatarUrl, lastOnlineAt: added.lastOnlineAt, role: added.role, source: "board", pinned: added.pinned, assignedItemsOnly: added.assignedItemsOnly, clientId: added.clientId, isOrganisationMember: added.isOrganisationMember });
  }

  /** Closes the add list and clears the search; false when there was nothing to close. */
  private closeAddList() {
    if (!this.showResults() && !this.query()) return false;
    this.query.set(""); this.addOpen.set(false);
    return true;
  }

  /** Closes the add list once focus leaves the field and its controls (not when it moves between them). */
  onAddFocusOut(event: FocusEvent) {
    const container = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node && container.contains(event.relatedTarget))) this.addOpen.set(false);
  }

  /**
   * Invites someone outside the organisation to this board only. The same request as the settings
   * guest form: an existing Kanera user is added at once, anyone else is emailed an invitation.
   */
  async inviteGuest(email: string) {
    if (this.busy()) return;
    if (!this.auth.guestsAllowed()) { await this.upgradePrompt.open({ reason: "guest", source: "board_members" }); return; }
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    this.busy.set(true); this.error.set(null);
    try {
      const role = this.addRole(); const assignedItemsOnly = this.addAssignedItemsOnly();
      if (!await this.confirmGuestSeat(email, role, assignedItemsOnly)) return;
      const result = await this.api.post<GuestInvitationResult>(`/workspaces/${workspaceId}/guests/invitations`, { boardId: this.boardId(), email, role, assignedItemsOnly });
      this.resetAddForm();
      if (result.status === "invited") this.toasts.success($localize`:Toast after inviting someone to a board by email:Invitation emailed to ${email}:email:.`, "mail");
      await this.reload(false);
    } catch (e) {
      await this.showGrantError(e);
    } finally { this.busy.set(false) }
  }

  /** An organisation invite by email that grants this board, for organisation admins. */
  async inviteMember(email: string) {
    if (!this.canInvite() || this.busy()) return;
    this.busy.set(true); this.error.set(null);
    let limit: { current: number } | null = null;
    try {
      await this.api.post("/clients/me/invites", {
        orgRole: "member", email, workspaces: [], boards: [{ boardId: this.boardId(), role: this.addRole() }], expiresInDays: INVITE_EXPIRES_IN_DAYS,
      });
      this.resetAddForm();
      this.toasts.success($localize`:Toast after inviting someone to a board by email:Invitation emailed to ${email}:email:.`, "mail");
      await this.reload(false);
    } catch (e) {
      limit = memberLimitError(e);
      if (!limit) this.error.set(errorMessage(e));
    } finally { this.busy.set(false) }
    if (limit) await this.upgradePrompt.open({ reason: "member", source: "board_members", projectedSeats: limit.current + 1 });
  }

  async revokeInvite(invite: BoardInviteRow) {
    if (this.busy() || !this.canRevoke(invite)) return;
    const previous = this.invites(); const previousLink = this.createdInvite();
    this.invites.update((rows) => rows.filter((row) => !(row.id === invite.id && row.kind === invite.kind)));
    // The link just made here is that same invite: once withdrawn it no longer works, so it must not
    // stay on screen ready to copy.
    if (invite.kind === "member" && previousLink?.id === invite.id) { this.createdInvite.set(null); this.inviteCopied.set(false); }
    this.busy.set(true); this.error.set(null);
    try {
      await this.api.delete(`/boards/${this.boardId()}/invites/${invite.id}?kind=${invite.kind}`);
    } catch (e) {
      this.invites.set(previous); this.createdInvite.set(previousLink);
      this.error.set(errorMessage(e));
    } finally { this.busy.set(false) }
  }

  /**
   * A guest's second board may take a purchased seat. Explain that before the grant, because the
   * next request allocates the seat immediately (the settings guest form asks the same question).
   */
  private async confirmGuestSeat(email: string, role: BoardRole, assignedItemsOnly: boolean): Promise<boolean> {
    const workspaceId = this.workspaceId();
    if (!workspaceId) return true;
    const preview = await this.api.post<GuestSeatPreview>(`/workspaces/${workspaceId}/guests/seat-preview`, { boardId: this.boardId(), email, role, assignedItemsOnly });
    if (!preview.paidGuestSeatRequired) return true;
    return this.confirm.open({
      title: $localize`Use a paid seat for this guest?`,
      message: $localize`A guest's first board is free. Adding their second board uses one of your purchased seats; further boards reuse that seat. Your bill will not change right now, and the seat becomes available again when their access returns to one board.`,
      confirmLabel: $localize`:Confirm button:Use seat`,
      danger: false,
    });
  }

  private async showGrantError(error: unknown) {
    if (guestsLimitError(error)) { await this.upgradePrompt.open({ reason: "guest", source: "board_members" }); return; }
    this.error.set(seatLimitError(error)
      ? $localize`Adding this guest needs a seat, but all purchased seats are in use. Buy more seats on the Account Plan page, then try again.`
      : errorMessage(error));
  }

  private resetAddForm() { this.query.set(""); this.addAssignedItemsOnly.set(false); }

  async changeRole(userId: string, role: BoardRole) { if (this.busy()) return; const previous = this.accessMembers(); if (previous.find(row => row.userId === userId)?.role === role) return; this.accessMembers.update(rows => rows.map(row => row.userId === userId ? { ...row, role } : row)); this.busy.set(true); this.error.set(null); try { await this.api.patch(`/boards/${this.boardId()}/members/${userId}`, { role }) } catch (e) { this.accessMembers.set(previous); this.error.set(errorMessage(e)) } finally { this.busy.set(false) } }
  async changeRestriction(member: BoardAccessMemberRow, assignedItemsOnly: boolean) { if (this.busy()) return; const previous = this.accessMembers(); this.accessMembers.update(rows => rows.map(row => row.userId === member.userId ? { ...row, assignedItemsOnly } : row)); this.busy.set(true); this.error.set(null); try { await this.api.patch(`/boards/${this.boardId()}/members/${member.userId}`, { role: member.role, assignedItemsOnly }) } catch (e) { this.accessMembers.set(previous); this.error.set(errorMessage(e)) } finally { this.busy.set(false) } }
  /**
   * Creates an organisation member invite whose only grant is this board, the same request the
   * settings invite form sends with one board ticked. Workspace membership comes with the board grant
   * on acceptance, so the newcomer finds the board on Home and in the sidebar.
   */
  async createInvite() {
    if (!this.canInvite() || this.busy()) return;
    this.busy.set(true); this.inviting.set(true); this.inviteError.set(null);
    let limit: { current: number } | null = null;
    try {
      const role = this.inviteRole();
      const res = await this.api.post<{ id: string; token: string; expiresAt: string | Date }>("/clients/me/invites", {
        orgRole: "member", workspaces: [], boards: [{ boardId: this.boardId(), role }], expiresInDays: INVITE_EXPIRES_IN_DAYS,
      });
      this.createdInvite.set({ id: res.id, url: `${location.origin}/signup?invite=${res.token}`, role, expiresAt: new Date(res.expiresAt).toISOString() });
      this.inviteCopied.set(false);
      await this.copyInviteLink();
      void this.reloadInvites();
    } catch (e) {
      limit = memberLimitError(e);
      if (!limit) this.inviteError.set(errorMessage(e));
    } finally {
      this.busy.set(false); this.inviting.set(false);
    }
    // The hosted Free seat cap: the same upgrade prompt as the settings invite form, quoting the team
    // this invite would make. Opened after busy clears so the popover can step aside for the dialog.
    if (limit) await this.upgradePrompt.open({ reason: "member", source: "board_members", projectedSeats: limit.current + 1 });
  }
  async copyInviteLink() {
    const invite = this.createdInvite();
    if (!invite) return;
    // A denied clipboard leaves the selectable field as the fallback, so "Copied" is only claimed on success.
    try { await copyToClipboard(invite.url); this.inviteCopied.set(true); } catch { this.inviteCopied.set(false); }
  }
  inviteHint(invite: CreatedInvite): string {
    const date = formatDate(invite.expiresAt, "short", { timeZone: this.auth.user()?.timezone });
    return invite.role === "editor"
      ? $localize`:Invite link hint in the board members menu; the placeholder is a date such as "23 Nov":Anyone with this link can join this board as an editor. It expires on ${date}:date:.`
      : $localize`:Invite link hint in the board members menu; the placeholder is a date such as "23 Nov":Anyone with this link can join this board as an observer. It expires on ${date}:date:.`;
  }
  canLeave(member: RenderedMemberRow): boolean {
    return member.userId === this.currentUserId() && !this.canManage() && !member.pinned
      && (member.role === "editor" || member.role === "observer");
  }
  async leaveMembership(member: RenderedMemberRow) {
    if (!this.canLeave(member) || this.busy() || this.confirmingRemoval()) return;
    this.confirmingRemoval.set(true);
    try {
      if (!await this.confirm.open({ title: $localize`:Confirm dialog title:Leave this board?`, confirmLabel: $localize`:Button — leave this board:Leave board`, danger: true, message: $localize`Your access, assignments, checklist assignments, watches, notifications, and Up Next entries will be removed. Admins will be notified. An admin must add or invite you to rejoin.` })) return;
      if (!this.unsavedWork.confirmNavigation()) return;
      this.busy.set(true);
      this.error.set(null);
      try {
        await this.api.delete(`/boards/${this.boardId()}/members/${member.userId}`);
        this.memberRemoved.emit(member.userId);
      } catch (error) {
        this.error.set(errorMessage(error));
      } finally {
        this.busy.set(false);
      }
    } finally {
      this.confirmingRemoval.set(false);
    }
  }
  async removeMember(member: BoardAccessMemberRow) {
    if (this.busy() || this.confirmingRemoval()) return;
    this.confirmingRemoval.set(true);
    try {
      const boardId = this.boardId();
      const index = this.accessMembers().indexOf(member);
      const restore = () => this.accessMembers.update(rows =>
        rows.some(row => row.userId === member.userId) ? rows : [...rows.slice(0, index), member, ...rows.slice(index)]);
      // Undo instead of confirm: the row hides now and the DELETE waits for the toast. memberRemoved
      // is only emitted once the removal is real, so the board page does not drop the member early.
      this.error.set(null);
      this.openAccessId.set(null);
      this.accessMembers.update(rows => rows.filter(row => row.userId !== member.userId));
      this.toasts.undoable({
        message: $localize`:Toast after removing a board member:${member.displayName}:name: removed from the board.`,
        icon: "user-minus",
        undo: restore,
        commit: async () => {
          try {
            await this.api.delete(`/boards/${boardId}/members/${member.userId}`);
            // Fast path for the board page; realtime board:member:removed covers a closed popover.
            if (!this.destroyed) this.memberRemoved.emit(member.userId);
          } catch (e) {
            restore();
            this.toasts.info($localize`:Toast when removing a board member fails:Couldn't remove ${member.displayName}:name:: ${errorMessage(e)}:error:`, "alert-triangle");
          }
        },
      });
    } finally {
      // The confirm button click continues bubbling after its promise resolves. Keep the popover
      // mounted through the DELETE so its success output still reaches the board page.
      this.confirmingRemoval.set(false);
    }
  }
  private snapshotKey() { return `${this.currentUserId() ?? ""}:${this.boardId()}`; }
  // Pending invites are a side panel of the roster: failing to read them must not hide the members.
  private loadInvites() { return this.api.get<BoardInviteRow[]>(`/boards/${this.boardId()}/invites`).catch(() => this.invites()); }
  private async reloadInvites() { this.invites.set(await this.loadInvites()); }
  private async reload(showLoading = true) { if (showLoading) this.loading.set(true); this.error.set(null); try { const [members, candidates, invites] = await Promise.all([this.api.get<BoardAccessMemberRow[]>(`/boards/${this.boardId()}/members`), this.api.get<BoardMemberCandidatesResponse>(`/boards/${this.boardId()}/member-candidates`), this.loadInvites()]); this.accessMembers.set(members); this.candidateScope.set(candidates.scope); this.roster.set(candidates.members); this.invites.set(invites ?? []); this.accessLoaded.set(true) } catch (e) { this.error.set(errorMessage(e)) } finally { this.loading.set(false) } }
  // Realtime events omit email/addedAt, so preserve the authoritative row where possible and
  // borrow identity fields from the candidate roster until the next full fetch.
  private readonly onMemberUpsert = ({ boardId, member, user }: Parameters<ServerToClientEvents["board:member:added"]>[0]) => { if (boardId !== this.boardId()) return; this.accessMembers.update(rows => { const old = rows.find(r => r.userId === member.userId); const roster = this.roster().find(r => r.userId === member.userId); const next: BoardAccessMemberRow = { boardId, userId: member.userId, role: member.role, assignedItemsOnly: member.assignedItemsOnly, pinned: member.pinned, addedAt: old?.addedAt ?? new Date(), email: old?.email ?? roster?.email ?? "", displayName: user.displayName, avatarUrl: user.avatarUrl, lastOnlineAt: user.lastOnlineAt, clientId: user.clientId ?? old?.clientId ?? this.ownerClientId() ?? "", isOrganisationMember: user.isOrganisationMember ?? old?.isOrganisationMember ?? false, accessSource: old?.accessSource ?? null }; return [...rows.filter(r => r.userId !== member.userId), next] }) };
  private readonly onMemberRemoved = ({ boardId, userId }: { boardId: string; userId: string }) => { if (boardId === this.boardId()) { this.accessMembers.update(rows => rows.filter(r => r.userId !== userId)); if (this.openAccessId() === userId) this.openAccessId.set(null); } };
  private readonly onClientUserRoleChanged = () => { void this.reload(false) };
}
