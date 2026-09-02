import { paginateOffset, type PageIterator } from "../pagination.js";
import type { AccessibleBoard, CreatedWorkspace, CreateWorkspaceInput, CustomField, Label, List, Member, Uuid, Workspace } from "../types.js";
import type { CallOptions, ResourceContext } from "./base.js";

export interface WorkspaceDetail {
  workspace: Workspace;
  lists: List[];
  customFields: CustomField[];
  labels: Label[];
}

export interface Automation {
  id: Uuid;
  workspaceId: Uuid;
  name: string;
  enabled: boolean;
  position: string;
  trigger: unknown;
  actions: unknown[];
}

export class Workspaces {
  constructor(private readonly ctx: ResourceContext) {}

  /** One page of accessible standard workspaces. Prefer {@link iterate} unless you are paging yourself. */
  list(options: { limit?: number; offset?: number } & CallOptions = {}): Promise<Workspace[]> {
    const { limit, offset, ...call } = options;
    return this.ctx.http.get<Workspace[]>("/api/v1/workspaces", { ...call, query: { limit, offset } });
  }

  iterate(options: { pageSize?: number } & CallOptions = {}): PageIterator<Workspace> {
    const { pageSize, ...call } = options;
    return paginateOffset((limit, offset) => this.list({ limit, offset, ...call }), pageSize);
  }

  /**
   * Bootstrap a workspace in one request: lists, custom fields, labels, checklist templates,
   * starter cards, automations, and an initial board are created in a single transaction.
   *
   * Requires an organisation admin or owner using a write-capable personal credential; a
   * workspace-scoped key is refused with 403. Pass `kind: "board"` plus `initialBoard` to create a
   * standalone board, which is hidden from {@link list} and appears in `boards.list()`.
   */
  create(body: CreateWorkspaceInput, options: CallOptions = {}): Promise<CreatedWorkspace> {
    return this.ctx.http.post<CreatedWorkspace>("/api/v1/workspaces", body, options);
  }

  /** A workspace with the lists, custom fields, and labels shared across all of its boards. */
  get(workspaceId: Uuid, options: CallOptions = {}): Promise<WorkspaceDetail> {
    return this.ctx.http.get<WorkspaceDetail>(`/api/v1/workspaces/${workspaceId}`, options);
  }

  boards(workspaceId: Uuid, options: CallOptions = {}): Promise<AccessibleBoard[]> {
    return this.ctx.http.get<AccessibleBoard[]>(`/api/v1/workspaces/${workspaceId}/boards`, options);
  }

  members(workspaceId: Uuid, options: { limit?: number; offset?: number } & CallOptions = {}): Promise<Member[]> {
    const { limit, offset, ...call } = options;
    return this.ctx.http.get<Member[]>(`/api/v1/workspaces/${workspaceId}/members`, { ...call, query: { limit, offset } });
  }

  iterateMembers(workspaceId: Uuid, options: { pageSize?: number } & CallOptions = {}): PageIterator<Member> {
    const { pageSize, ...call } = options;
    return paginateOffset((limit, offset) => this.members(workspaceId, { limit, offset, ...call }), pageSize);
  }

  /** Requires workspace-admin authority. */
  automations(workspaceId: Uuid, options: CallOptions = {}): Promise<Automation[]> {
    return this.ctx.http.get<Automation[]>(`/api/v1/workspaces/${workspaceId}/automations`, options);
  }

  createAutomation(workspaceId: Uuid, body: Record<string, unknown>, options: CallOptions = {}): Promise<Automation> {
    return this.ctx.http.post<Automation>(`/api/v1/workspaces/${workspaceId}/automations`, body, options);
  }
}

export class Automations {
  constructor(private readonly ctx: ResourceContext) {}

  update(automationId: Uuid, body: Record<string, unknown>, options: CallOptions = {}): Promise<Automation> {
    return this.ctx.http.patch<Automation>(`/api/v1/automations/${automationId}`, body, options);
  }

  delete(automationId: Uuid, options: CallOptions = {}): Promise<void> {
    return this.ctx.http.delete<void>(`/api/v1/automations/${automationId}`, options);
  }

  executions(
    automationId: Uuid,
    options: { cursor?: string; limit?: number } & CallOptions = {},
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const { cursor, limit, ...call } = options;
    return this.ctx.http.get(`/api/v1/automations/${automationId}/executions`, { ...call, query: { cursor, limit } });
  }
}
