import { dto } from "@kanera/shared";
import { z } from "zod";

type HttpMethod = "get" | "post" | "patch" | "put" | "delete";
type Schema = Record<string, unknown>;
type Operation = {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Schema[];
  requestBody?: Schema;
  responses: Schema;
};

const bearerSecurity: Array<Record<string, string[]>> = [{ BearerAuth: [] }, { KaneraOAuth: ["kanera:read", "kanera:write"] }];

function zodSchema(schema: z.ZodType): Schema {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Schema;
  delete jsonSchema.$schema;
  return jsonSchema;
}

const idParam = (name = "id", description?: string): Schema => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" },
});

const queryParam = (name: string, schema: Schema, description?: string): Schema => ({
  name,
  in: "query",
  required: false,
  description,
  schema,
});

const jsonBody = (schema: Schema, description?: string): Schema => ({
  required: true,
  description,
  content: { "application/json": { schema } },
});

const multipartBody = (description: string): Schema => ({
  required: true,
  description,
  content: {
    "multipart/form-data": {
      schema: {
        type: "object",
        required: ["file"],
        properties: {
          file: { type: "string", format: "binary" },
        },
      },
    },
  },
});

const ok = (schema: Schema, description = "Success."): Schema => ({
  description,
  content: { "application/json": { schema } },
});

const created = (schema: Schema): Schema => ok(schema, "Created.");
const noContent: Schema = { description: "Deleted or updated successfully with no response body." };

const errorResponses: Schema = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" },
  "500": { $ref: "#/components/responses/Internal" },
};

const authedResponses = (responses: Schema): Schema => ({ ...responses, ...errorResponses });

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (schema: Schema): Schema => ({ type: "array", items: schema });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });

const dateTime = { type: "string", format: "date-time" };
const uuid = { type: "string", format: "uuid" };
const position = { type: "string", example: "1000.0000000000" };

export const publicWebhookEventTypes = [
  "list:created",
  "list:updated",
  "list:moved",
  "list:rebalanced",
  "list:deleted",
  "customField:created",
  "customField:updated",
  "customField:moved",
  "customField:rebalanced",
  "customField:deleted",
  "customFieldOption:created",
  "customFieldOption:updated",
  "customFieldOption:moved",
  "customFieldOption:rebalanced",
  "customFieldOption:deleted",
  "card:created",
  "card:updated",
  "card:moved",
  "card:rebalanced",
  "card:deleted",
  "card:customFieldValue:set",
  "card:customFieldValue:cleared",
  "card:labels:set",
  "card:assignees:set",
  "card:attachment:created",
  "card:attachment:deleted",
  "card:checklist:created",
  "card:checklist:updated",
  "card:checklist:moved",
  "card:checklist:rebalanced",
  "card:checklist:deleted",
  "card:checklistItem:created",
  "card:checklistItem:updated",
  "card:checklistItem:moved",
  "card:checklistItem:rebalanced",
  "card:checklistItem:deleted",
  "cardLabel:created",
  "cardLabel:updated",
  "cardLabel:moved",
  "cardLabel:rebalanced",
  "cardLabel:deleted",
  "comment:created",
  "comment:updated",
  "comment:deleted",
  "comment:reaction:added",
  "comment:reaction:removed",
  "card:feedItem:created",
  "card:feedItem:updated",
  "card:feedItem:deleted",
  "board:created",
  "board:updated",
  "board:moved",
  "board:rebalanced",
  "board:deleted",
  "board:member:added",
  "board:member:removed",
  "boardMirror:created",
  "boardMirror:updated",
  "boardMirror:deleted",
  "workspace:updated",
  "workspace:deleted",
  "workspace:member:added",
  "workspace:member:updated",
  "workspace:member:removed",
  "user:profile:updated",
  "note:created",
  "note:updated",
  "note:moved",
  "note:rebalanced",
  "note:deleted",
  "note:locked",
  "note:unlocked",
] as const;

function operation(input: Omit<Operation, "security"> & { public?: boolean }): Operation {
  const { public: isPublic, ...rest } = input;
  return { ...rest, ...(isPublic ? {} : { security: bearerSecurity }) };
}

function pathItem(method: HttpMethod, op: Operation): Record<HttpMethod, Operation> {
  return { [method]: op } as Record<HttpMethod, Operation>;
}

const paginationParams = [
  queryParam("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 }),
  queryParam("before", { type: "string", format: "date-time" }),
];

const publicApiDescription = `Kanera's public API lets you build integrations around the same workspace, board, card, note, comment, attachment, activity, and external-link data that users manage in the app.

## Quickstart

1. In Kanera, open **Workspace Settings -> API** as a workspace admin or owner.
2. Create a workspace API key and copy the secret. It is shown once.
3. Send the key as a bearer token:

\`\`\`bash
curl "$KANERA_PUBLIC_API_URL/api/v1/workspaces" \\
  -H "Authorization: Bearer kanera_<env>_..."
\`\`\`

The OpenAPI document at \`/openapi.json\` is the source of truth for this reference, Scalar at \`/docs\`, Swagger UI at \`/swagger\`, and SDK generation.

## Base URL and Versioning

All REST endpoints are under \`/api/v1\` on the public API service. Signed media URLs and webhook event discovery live outside that prefix because they are operational helpers rather than workspace resources.

## Authentication

Use an API key in \`Authorization: Bearer kanera_<env>_...\` where \`<env>\` is \`live\`, \`stg\`, \`dev\`, or \`test\`. Missing or invalid keys return \`401\`; valid keys without access to a resource return \`403\`.

OAuth-capable agents can instead discover the authorization server from the MCP protected-resource metadata, complete authorization code + PKCE in the browser, and send the resulting short-lived \`kanera_oauth_...\` bearer token. Unattended workspace agents use a confidential service connection with the \`client_credentials\` grant.

There are two kinds of key:

- **Workspace keys** (created by a workspace admin) are workspace-scoped: they can only access resources in the workspace where the key was created, with powers set by the key's \`read\`/\`write\`/\`admin\` scope.
- **Personal keys** (created by any user under Account settings) act as their owner across every organisation, workspace, and board the owner can access, respecting the owner's current role at each scope; activity is attributed to the owner. Personal keys are identifiable by a \`u\` marker in the prefix: \`kanera_u_<env>_...\`.

## Workspace Model

Kanera is intentionally workspace-first:

- Lists are shared by every board in a workspace.
- Custom fields are shared by every board in a workspace.
- Workspace membership grants workspace-level access. Cross-organisation guests instead receive explicit access to individual boards and are not workspace members.
- External links map outside-system records to Kanera entities so sync jobs can be safely retried.

Standalone boards use the same model without exposing a workspace shell: a workspace with
\`kind="board"\` owns exactly one board and its shared lists, fields, labels, automations, templates,
webhooks, keys, and guests. These hidden workspaces are omitted from \`GET /workspaces\`, but appear in
\`GET /home/boards\` under \`groups\`; a workspace-scoped key created there can still open its pinned
workspace. Creating another board is rejected. Imports started from the Kanera app populate the
existing sole board instead of creating a second one.

\`GET /workspaces\` therefore returns only workspaces the credential can access at workspace scope. It does not return the parent workspaces of boards shared with a cross-organisation guest. With a personal key or user OAuth token, use \`GET /home/boards\` to discover both workspace-accessible boards in \`groups\` and board-only guest access in \`guestGroups\`. A guest-group workspace is grouping context for its shared boards, not permission to call workspace-scoped endpoints.

## Common Flows

List your workspaces, open a workspace or board, then mutate the resource you need:

\`\`\`bash
curl "$KANERA_PUBLIC_API_URL/api/v1/workspaces" \\
  -H "Authorization: Bearer $KANERA_API_KEY"

curl "$KANERA_PUBLIC_API_URL/api/v1/workspaces/$WORKSPACE_ID/boards" \\
  -H "Authorization: Bearer $KANERA_API_KEY"

# With a personal key, include board-only cross-organisation guest access.
curl "$KANERA_PUBLIC_API_URL/api/v1/home/boards" \\
  -H "Authorization: Bearer $KANERA_API_KEY"

curl "$KANERA_PUBLIC_API_URL/api/v1/boards/$BOARD_ID/lists/$LIST_ID/cards" \\
  -X POST \\
  -H "Authorization: Bearer $KANERA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Follow up with Acme"}'

curl "$KANERA_PUBLIC_API_URL/api/v1/cards/$CARD_ID" \\
  -X PATCH \\
  -H "Authorization: Bearer $KANERA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"description":"Imported from CRM"}'
\`\`\`

## Pagination and Errors

List endpoints that support pagination use \`limit\` and \`before\` query parameters. Errors return JSON with a stable \`code\`, a human-readable \`message\`, and optional validation \`issues\`.

## Webhooks

Create webhook endpoints in **Workspace Settings -> API**. Kanera sends matching workspace and board events to your endpoint as JSON. Leave \`eventTypes\` empty to receive every event, or use \`/webhook-event-types\` to discover the strings you can filter on.

Each delivery includes:

- \`X-Kanera-Event-Id\`: unique event id, also present as \`payload.id\`.
- \`X-Kanera-Timestamp\`: Unix timestamp in seconds.
- \`X-Kanera-Signature\`: \`sha256=\` plus HMAC-SHA256 over \`\${timestamp}.\${rawBody}\` using the endpoint secret.

Webhook deliveries are retried up to 8 attempts. The scheduler checks queued deliveries every 10 seconds, uses exponential backoff starting at 30 seconds, and caps the delay at 1 hour. Any 2xx response marks the delivery successful; non-2xx responses and network failures are retried until attempts are exhausted.

\`\`\`ts
import crypto from "node:crypto";
import express from "express";

const app = express();

app.post("/kanera/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const timestamp = req.header("X-Kanera-Timestamp") ?? "";
  const signature = req.header("X-Kanera-Signature") ?? "";
  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.KANERA_WEBHOOK_SECRET!)
    .update(\`\${timestamp}.\${req.body.toString("utf8")}\`)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).send("invalid signature");
  }

  const event = JSON.parse(req.body.toString("utf8"));
  // Handle event.type, event.workspaceId, event.boardId, event.cardId, and event.data.
  res.sendStatus(204);
});
\`\`\``;

const webhookTagDescription = `Configure signed outgoing webhooks from **Workspace Settings -> API**.

Kanera sends JSON payloads with \`X-Kanera-Event-Id\`, \`X-Kanera-Timestamp\`, and \`X-Kanera-Signature\`. Verify \`X-Kanera-Signature\` as \`sha256=\` plus HMAC-SHA256 over \`\${timestamp}.\${rawBody}\` using the endpoint secret. Leave an endpoint's \`eventTypes\` empty for all events, or call \`/webhook-event-types\` to build a filtered list.`;

export const publicOpenApiDocument: Record<string, unknown> = {
  openapi: "3.0.3",
  info: {
    title: "Kanera Public API",
    version: "1.0.0",
    description: publicApiDescription,
  },
  servers: [{ url: "/api/v1", description: "Public API v1" }],
  tags: [
    { name: "Health", description: "Check whether the public API process is alive before sending integration traffic." },
    { name: "Workspaces", description: "Discover workspace-level access and manage workspace membership and boards. Board-only cross-organisation guest access is returned separately by `GET /home/boards`." },
    { name: "Boards", description: "Create, open, reorder, update, and remove boards. Remember that lists and custom fields belong to the workspace, not to individual boards." },
    { name: "Board Access", description: "Manage organisation-member permissions and cross-organisation guest access for boards. Standalone boards use these board-level permissions without exposing their hidden workspace roster." },
    { name: "Assigned Work", description: "Read cards assigned to a specific workspace member for personal or team workload views." },
    { name: "Lists", description: "Manage the shared workflow lists for a workspace. Moving a list changes its position everywhere in that workspace." },
    { name: "Notes", description: "Read and manage workspace notes and board notes, including lock/unlock behavior for collaborative editing." },
    { name: "Cards", description: "Create and update cards, move them through workspace lists, manage checklist data, labels, assignees, completion, and custom field values." },
    { name: "Attachments", description: "Upload and read card or note media. Use URLs returned by the API as-is; signed media links should not be constructed manually." },
    { name: "Custom Fields", description: "Manage workspace-scoped custom fields that are available on cards across every board in the workspace." },
    { name: "Card Labels", description: "Manage workspace-scoped labels that can be applied to cards across boards." },
    { name: "Comments", description: "Read and write card comments, reactions, and feed items for integration notes or activity sync." },
    { name: "Activity", description: "Read audit-style activity for boards so integrations can inspect recent changes." },
    {
      name: "External Links",
      description: "Durable mappings between outside-system records and Kanera entities. Use these to make sync jobs idempotent without storing integration metadata in card text.",
    },
    { name: "Media", description: "Read signed media URLs returned by API responses. Treat signed URLs as opaque and short-lived." },
    {
      name: "Webhooks",
      description: webhookTagDescription,
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Kanera workspace API key",
        description: "Use `Authorization: Bearer kanera_<env>_...`.",
      },
      KaneraOAuth: {
        type: "oauth2",
        description: "Short-lived user or workspace-service OAuth tokens.",
        flows: {
          authorizationCode: {
            authorizationUrl: "/oauth/authorize",
            tokenUrl: "/oauth/token",
            scopes: {
              "kanera:read": "Read accessible Kanera project data.",
              "kanera:write": "Create and update accessible Kanera content, including supported workspace administration where the authorizing user is an administrator.",
            },
          },
          clientCredentials: {
            tokenUrl: "/oauth/token",
            scopes: {
              "kanera:read": "Read the service connection's workspace.",
              "kanera:write": "Create and update content in the service connection's workspace.",
              "kanera:admin": "Perform supported workspace-admin API operations.",
            },
          },
        },
      },
    },
    responses: {
      BadRequest: { description: "Bad request or validation error.", content: { "application/json": { schema: ref("Error") } } },
      Unauthorized: { description: "Missing or invalid bearer token.", content: { "application/json": { schema: ref("Error") } } },
      Forbidden: { description: "Authenticated principal does not have access.", content: { "application/json": { schema: ref("Error") } } },
      NotFound: { description: "Resource not found.", content: { "application/json": { schema: ref("Error") } } },
      Conflict: { description: "Resource conflict.", content: { "application/json": { schema: ref("Error") } } },
      Internal: { description: "Unexpected server error.", content: { "application/json": { schema: ref("Error") } } },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", examples: ["VALIDATION", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "INTERNAL"] },
          message: { type: "string" },
          issues: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        additionalProperties: true,
      },
      Health: { type: "object", required: ["ok", "service"], properties: { ok: { type: "boolean" }, service: { type: "string" } } },
      User: {
        type: "object",
        required: ["id", "clientId", "email", "displayName", "clientRole", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          clientId: uuid,
          email: { type: "string", format: "email" },
          displayName: { type: "string" },
          avatarUrl: nullable({ type: "string", format: "uri" }),
          clientRole: { type: "string", enum: ["owner", "admin", "member"] },
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      Workspace: {
        type: "object",
        required: ["id", "clientId", "name", "kind", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          clientId: uuid,
          name: { type: "string" },
          kind: { type: "string", enum: ["standard", "board"], description: "`board` identifies a hidden one-board workspace presented as a standalone board." },
          icon: nullable({ type: "string" }),
          accentColor: nullable({ type: "string" }),
          completedCardsActiveDays: { type: "integer", minimum: 0, maximum: 365 },
          role: { type: "string", enum: ["admin", "member"] },
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      GuestWorkspaceSummary: {
        type: "object",
        description: "Parent-workspace context for explicitly shared guest boards. This does not grant access to workspace-scoped endpoints.",
        required: ["id", "clientId", "name", "kind", "role", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          clientId: uuid,
          name: { type: "string" },
          kind: { type: "string", enum: ["standard", "board"], description: "Use `board` to identify a standalone guest board group." },
          icon: nullable({ type: "string" }),
          accentColor: nullable({ type: "string" }),
          role: { type: "string", enum: ["observer", "editor"], description: "The credential owner's role on one of the explicitly shared boards in this group." },
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      WorkspaceDetail: {
        type: "object",
        required: ["workspace", "role", "lists", "customFields", "cardLabels"],
        properties: {
          workspace: ref("Workspace"),
          role: { type: "string", enum: ["admin", "member"], description: "The credential owner's effective role for this workspace." },
          lists: arrayOf(ref("List")),
          customFields: arrayOf(ref("CustomField")),
          cardLabels: arrayOf(ref("CardLabel")),
        },
      },
      WorkspaceMember: {
        type: "object",
        required: ["workspaceId", "userId", "role"],
        properties: { workspaceId: uuid, userId: uuid, role: { type: "string", enum: ["admin", "member"] }, user: ref("User") },
        additionalProperties: true,
      },
      CreatedWorkspace: {
        allOf: [
          ref("Workspace"),
          {
            type: "object",
            properties: {
              initialBoard: ref("Board"),
            },
          },
        ],
        description: "The created workspace. When kind is `board`, `initialBoard` is the standalone board and supplies the board id to open next.",
      },
      ExternalLink: {
        type: "object",
        required: ["id", "workspaceId", "provider", "externalType", "externalId", "entityType", "entityId", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          workspaceId: uuid,
          provider: { type: "string", examples: ["trello", "github", "linear"] },
          externalType: { type: "string", examples: ["card", "comment", "issue"] },
          externalId: { type: "string" },
          entityType: { type: "string", enum: ["card", "comment", "cardAttachment", "cardChecklist", "cardChecklistItem"] },
          entityId: uuid,
          createdAt: dateTime,
          updatedAt: dateTime,
        },
      },
      Board: {
        type: "object",
        required: ["id", "workspaceId", "name", "position", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          workspaceId: uuid,
          name: { type: "string" },
          description: nullable({ type: "string" }),
          icon: nullable({ type: "string" }),
          iconColor: nullable({ type: "string" }),
          backgroundGradient: nullable({ type: "string" }),
          standaloneGroupId: nullable(uuid),
          position,
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      BoardMember: {
        type: "object",
        required: ["boardId", "userId", "role", "assignedItemsOnly"],
        properties: {
          boardId: uuid,
          userId: uuid,
          role: { type: "string", enum: ["editor", "observer"] },
          assignedItemsOnly: { type: "boolean" },
          pinned: { type: "boolean", description: "Inherited administrators are pinned and cannot be changed or removed through board permission methods." },
          email: { type: "string", format: "email" },
          displayName: { type: "string" },
          avatarUrl: nullable({ type: "string", format: "uri" }),
          lastOnlineAt: nullable(dateTime),
          clientId: uuid,
        },
        additionalProperties: true,
      },
      BoardMemberCandidate: {
        type: "object",
        required: ["userId", "email", "displayName", "clientId"],
        properties: {
          userId: uuid,
          email: { type: "string", format: "email" },
          displayName: { type: "string" },
          avatarUrl: nullable({ type: "string", format: "uri" }),
          lastOnlineAt: nullable(dateTime),
          clientId: uuid,
        },
        additionalProperties: true,
      },
      BoardMemberCandidates: {
        type: "object",
        required: ["scope", "members"],
        properties: {
          scope: { type: "string", enum: ["workspace", "organisation"] },
          members: arrayOf(ref("BoardMemberCandidate")),
        },
        additionalProperties: false,
      },
      StandaloneBoardGuestInvitationBody: {
        type: "object",
        required: ["boardId", "email"],
        properties: {
          boardId: uuid,
          email: { type: "string", format: "email" },
          role: { type: "string", enum: ["editor", "observer"], default: "editor" },
          assignedItemsOnly: { type: "boolean", default: false },
          expiresInDays: nullable({ type: "integer", minimum: 1, maximum: 365 }),
        },
        additionalProperties: false,
      },
      StandaloneBoardGuests: {
        type: "object",
        description: "Accepted cross-organisation guests and pending invitations for the boards in a workspace. A standalone workspace contains exactly one board.",
        required: ["boards", "acceptedGuests", "pendingInvites"],
        properties: {
          boards: arrayOf({
            type: "object",
            required: ["id", "name", "position"],
            properties: {
              id: uuid,
              name: { type: "string" },
              icon: nullable({ type: "string" }),
              iconColor: nullable({ type: "string" }),
              position,
            },
            additionalProperties: true,
          }),
          acceptedGuests: arrayOf(ref("BoardMember")),
          pendingInvites: arrayOf({ type: "object", additionalProperties: true }),
        },
        additionalProperties: true,
      },
      BoardDetail: {
        type: "object",
        required: ["board", "lists", "customFields", "cardLabels", "members"],
        properties: {
          board: ref("Board"),
          lists: arrayOf(ref("List")),
          cards: arrayOf(ref("Card")),
          cardPage: {
            type: "object",
            required: ["offset", "limit", "hasMore"],
            properties: {
              offset: { type: "integer", minimum: 0 },
              limit: { type: "integer", minimum: 1, maximum: 100 },
              hasMore: { type: "boolean" },
            },
            additionalProperties: false,
          },
          customFields: arrayOf(ref("CustomField")),
          cardLabels: arrayOf(ref("CardLabel")),
          members: arrayOf(ref("User")),
        },
        additionalProperties: true,
      },
      List: {
        type: "object",
        required: ["id", "workspaceId", "name", "position", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          workspaceId: uuid,
          name: { type: "string" },
          position,
          archivedAt: nullable(dateTime),
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      Card: {
        type: "object",
        required: ["id", "boardId", "listId", "title", "position", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          boardId: uuid,
          listId: uuid,
          title: { type: "string" },
          description: nullable({ type: "string" }),
          url: { type: "string", format: "uri" },
          position,
          completedAt: nullable(dateTime),
          archivedAt: nullable(dateTime),
          dueDateLocalDate: nullable({ type: "string", format: "date" }),
          dueDateSlot: nullable({ type: "string", enum: ["anyTime", "morning", "afternoon", "endOfWorkDay"] }),
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      CardDetail: {
        type: "object",
        description: "A card plus assignees, labels, custom field values, checklists, attachments, comments, and activity metadata.",
        allOf: [ref("Card")],
        additionalProperties: true,
      },
      CardAttachment: {
        type: "object",
        required: ["id", "cardId", "fileName", "mimeType", "sizeBytes", "url", "createdAt"],
        properties: {
          id: uuid,
          cardId: uuid,
          fileName: { type: "string" },
          mimeType: { type: "string" },
          sizeBytes: { type: "integer" },
          url: { type: "string", format: "uri" },
          thumbnailUrl: nullable({ type: "string", format: "uri" }),
          coverImageUrl: nullable({ type: "string", format: "uri" }),
          createdAt: dateTime,
        },
        additionalProperties: true,
      },
      CustomField: {
        type: "object",
        required: ["id", "workspaceId", "name", "type", "position", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          workspaceId: uuid,
          name: { type: "string" },
          icon: { type: "string" },
          type: { type: "string", enum: ["text", "number", "checkbox", "select", "date", "url", "user"] },
          allowMultiple: { type: "boolean" },
          position,
          archivedAt: nullable(dateTime),
          createdAt: dateTime,
          updatedAt: dateTime,
          options: arrayOf(ref("CustomFieldOption")),
        },
        additionalProperties: true,
      },
      CustomFieldOption: {
        type: "object",
        required: ["id", "fieldId", "label", "position", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          fieldId: uuid,
          label: { type: "string" },
          color: nullable({ type: "string" }),
          position,
          archivedAt: nullable(dateTime),
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      CustomFieldValue: {
        type: "object",
        properties: {
          cardId: uuid,
          fieldId: uuid,
          value: nullable({ oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] }),
        },
        additionalProperties: true,
      },
      CardLabel: {
        type: "object",
        required: ["id", "workspaceId", "name", "position", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          workspaceId: uuid,
          name: { type: "string" },
          color: nullable({ type: "string" }),
          position,
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      Checklist: {
        type: "object",
        required: ["id", "cardId", "parentItemId", "title", "position", "items"],
        properties: {
          id: uuid,
          cardId: uuid,
          parentItemId: nullable({ ...uuid, description: "Owning top-level checklist item for a one-level sub-checklist; null for a card-level checklist." }),
          title: { type: "string" },
          position,
          items: arrayOf(ref("ChecklistItem")),
        },
        additionalProperties: true,
      },
      ChecklistItem: {
        type: "object",
        required: ["id", "checklistId", "text", "description", "position", "assigneeId", "dueDateLocalDate", "dueDateSlot", "dueDateTimezone", "completedAt", "completedById", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          checklistId: uuid,
          text: { type: "string" },
          description: nullable({ type: "string", description: "Markdown detail for a top-level item. Sub-checklist leaf items always return null." }),
          position,
          assigneeId: nullable(uuid),
          dueDateLocalDate: nullable({ type: "string", format: "date" }),
          dueDateSlot: nullable({ type: "string", enum: ["anyTime", "morning", "afternoon", "endOfWorkDay"] }),
          dueDateTimezone: nullable({ type: "string" }),
          completedAt: nullable(dateTime),
          completedById: nullable(uuid),
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      Note: {
        type: "object",
        required: ["id", "workspaceId", "title", "body", "createdAt", "updatedAt"],
        properties: {
          id: uuid,
          workspaceId: uuid,
          boardId: nullable(uuid),
          title: { type: "string" },
          body: { type: "string" },
          lockedById: nullable(uuid),
          createdAt: dateTime,
          updatedAt: dateTime,
        },
        additionalProperties: true,
      },
      NotePage: { type: "object", required: ["items"], properties: { items: arrayOf(ref("Note")) }, additionalProperties: true },
      Comment: {
        type: "object",
        required: ["id", "cardId", "authorId", "authorKind", "apiKeyId", "apiKeyName", "authorName", "authorAvatarUrl", "body", "editedAt", "reactions", "createdAt"],
        properties: {
          id: uuid,
          cardId: uuid,
          authorId: uuid,
          authorKind: { type: "string", enum: ["user", "apiKey", "system"] },
          apiKeyId: nullable(uuid),
          apiKeyName: nullable({ type: "string" }),
          authorName: { type: "string" },
          authorAvatarUrl: nullable({ type: "string" }),
          body: { type: "string" },
          editedAt: nullable(dateTime),
          reactions: arrayOf({ type: "object", additionalProperties: true }),
          createdAt: dateTime,
        },
        additionalProperties: true,
      },
      ContentQueryComment: {
        type: "object",
        required: ["id", "cardId", "authorId", "authorKind", "apiKeyId", "apiKeyName", "authorName", "body", "editedAt", "createdAt"],
        properties: {
          id: uuid,
          cardId: uuid,
          authorId: uuid,
          authorKind: { type: "string", enum: ["user", "apiKey", "system"] },
          apiKeyId: nullable(uuid),
          apiKeyName: nullable({ type: "string" }),
          authorName: { type: "string" },
          body: { type: "string" },
          editedAt: nullable(dateTime),
          createdAt: dateTime,
        },
        additionalProperties: false,
      },
      CommentPage: { type: "object", required: ["items"], properties: { items: arrayOf(ref("Comment")) }, additionalProperties: true },
      ActivityEvent: {
        type: "object",
        required: ["id", "entityType", "entityId", "action", "createdAt"],
        properties: {
          id: uuid,
          entityType: { type: "string" },
          entityId: uuid,
          action: { type: "string" },
          actorId: nullable(uuid),
          actorKind: { type: "string", enum: ["user", "apiKey"] },
          apiKeyId: nullable(uuid),
          apiKeyName: nullable({ type: "string" }),
          data: { type: "object", additionalProperties: true },
          createdAt: dateTime,
        },
        additionalProperties: true,
      },
      ActivityPage: { type: "object", required: ["items"], properties: { items: arrayOf(ref("ActivityEvent")) }, additionalProperties: true },
      CardFeedPage: { type: "object", required: ["items"], properties: { items: arrayOf({ type: "object", additionalProperties: true }) }, additionalProperties: true },
      AssignedCardsPage: { type: "object", required: ["items"], properties: { items: arrayOf(ref("Card")) }, additionalProperties: true },
      HomeBoard: {
        type: "object",
        required: ["id", "workspaceId", "name", "position", "myCards", "myOverdue"],
        properties: {
          id: uuid,
          workspaceId: uuid,
          name: { type: "string" },
          icon: nullable({ type: "string" }),
          iconColor: nullable({ type: "string" }),
          backgroundGradient: nullable({ type: "string" }),
          groupId: nullable(uuid),
          standaloneGroupId: nullable(uuid),
          position,
          myCards: { type: "integer", minimum: 0 },
          myOverdue: { type: "integer", minimum: 0 },
        },
        additionalProperties: true,
      },
      HomeBoardGroup: {
        type: "object",
        required: ["id", "workspaceId", "title", "position", "createdAt", "updatedAt"],
        properties: { id: uuid, workspaceId: uuid, title: { type: "string" }, position, createdAt: dateTime, updatedAt: dateTime },
        additionalProperties: true,
      },
      StandaloneBoardGroup: {
        type: "object",
        required: ["id", "clientId", "title", "createdAt", "updatedAt"],
        properties: { id: uuid, clientId: uuid, title: { type: "string" }, createdAt: dateTime, updatedAt: dateTime },
        additionalProperties: false,
      },
      HomeWorkspaceMember: {
        type: "object",
        required: ["userId", "displayName", "role"],
        properties: {
          userId: uuid,
          displayName: { type: "string" },
          avatarUrl: nullable({ type: "string", format: "uri" }),
          lastOnlineAt: nullable(dateTime),
          role: { type: "string", enum: ["admin", "member"] },
        },
        additionalProperties: true,
      },
      HomeWorkspaceGroup: {
        type: "object",
        required: ["workspace", "boardGroups", "boards", "members"],
        properties: {
          workspace: ref("Workspace"),
          boardGroups: arrayOf(ref("HomeBoardGroup")),
          boards: arrayOf(ref("HomeBoard")),
          members: arrayOf(ref("HomeWorkspaceMember")),
        },
        additionalProperties: true,
      },
      GuestHomeWorkspaceGroup: {
        type: "object",
        description: "Boards shared explicitly with a cross-organisation guest, grouped by their parent workspace for display and discovery.",
        required: ["workspace", "clientName", "boardGroups", "boards"],
        properties: {
          workspace: ref("GuestWorkspaceSummary"),
          clientName: { type: "string" },
          boardGroups: arrayOf(ref("HomeBoardGroup")),
          boards: arrayOf(ref("HomeBoard")),
        },
        additionalProperties: true,
      },
      DueSoonItem: {
        type: "object",
        required: ["kind", "id", "boardId", "workspaceId", "title", "boardName", "dueDateLocalDate"],
        properties: {
          kind: { type: "string", enum: ["card", "checklistItem"] },
          id: uuid,
          cardId: uuid,
          cardTitle: { type: "string" },
          itemText: { type: "string" },
          boardId: uuid,
          workspaceId: uuid,
          title: { type: "string" },
          boardName: { type: "string" },
          boardIcon: nullable({ type: "string" }),
          dueDateLocalDate: { type: "string", format: "date" },
          dueDateSlot: nullable({ type: "string", enum: ["anyTime", "morning", "afternoon", "endOfWorkDay"] }),
          dueDateTimezone: nullable({ type: "string" }),
        },
        additionalProperties: true,
      },
      HomeBoardsPage: {
        type: "object",
        required: ["groups", "dueSoon"],
        properties: {
          groups: arrayOf(ref("HomeWorkspaceGroup")),
          guestGroups: arrayOf(ref("GuestHomeWorkspaceGroup")),
          standaloneBoardGroups: arrayOf(ref("StandaloneBoardGroup")),
          dueSoon: arrayOf(ref("DueSoonItem")),
          overdueChecklistItems: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      WebhookEventType: {
        type: "string",
        enum: [...publicWebhookEventTypes],
        description: "A workspace- or board-scoped event that can be selected for webhook delivery.",
      },
      WebhookEventTypesResponse: {
        type: "object",
        required: ["eventTypes"],
        properties: {
          eventTypes: arrayOf(ref("WebhookEventType")),
        },
      },
      WebhookDeliveryPayload: {
        type: "object",
        required: ["id", "type", "workspaceId", "occurredAt", "data"],
        properties: {
          id: { type: "string", format: "uuid", description: "Unique webhook event id. Also sent as `X-Kanera-Event-Id`." },
          type: ref("WebhookEventType"),
          workspaceId: uuid,
          boardId: nullable(uuid),
          cardId: nullable(uuid),
          occurredAt: dateTime,
          data: {
            type: "object",
            description: "The full event payload. This matches the corresponding realtime event payload.",
            additionalProperties: true,
          },
        },
        example: {
          id: "7e5c982a-e6c9-4ea7-9647-b14fe73ed50a",
          type: "card:created",
          workspaceId: "a069fd45-3bb3-4928-bac9-cb574a050d20",
          boardId: "48a52a55-763e-4c64-8a76-51ac56247f5c",
          cardId: "70c39cef-1aec-44e6-a8f5-f36f765a818d",
          occurredAt: "2026-05-28T12:34:56.000Z",
          data: {
            boardId: "48a52a55-763e-4c64-8a76-51ac56247f5c",
            card: {
              id: "70c39cef-1aec-44e6-a8f5-f36f765a818d",
              boardId: "48a52a55-763e-4c64-8a76-51ac56247f5c",
              listId: "3bb3c1b3-8fc7-4807-854d-2d5ff62df147",
              title: "Prepare kickoff agenda",
              position: "1000.0000000000",
            },
          },
        },
        additionalProperties: false,
      },
      CreateWorkspaceBody: zodSchema(dto.createWorkspaceBody),
      UpdateWorkspaceBody: zodSchema(dto.updateWorkspaceBody),
      AddWorkspaceMemberBody: zodSchema(dto.addWorkspaceMemberBody),
      UpdateWorkspaceMemberBody: zodSchema(dto.updateWorkspaceMemberBody),
      CreateBoardBody: zodSchema(dto.createBoardBody),
      UpdateBoardBody: zodSchema(dto.updateBoardBody),
      MoveBoardBody: zodSchema(dto.moveBoardBody),
      UpdateBoardBackgroundBody: zodSchema(dto.updateBoardBackgroundBody),
      AddBoardMemberBody: zodSchema(dto.addBoardMemberBody),
      UpdateBoardMemberBody: zodSchema(dto.updateBoardMemberBody),
      CreateListBody: zodSchema(dto.createListBody),
      UpdateListBody: zodSchema(dto.updateListBody),
      MoveListBody: zodSchema(dto.moveListBody),
      MoveListCardsBody: zodSchema(dto.moveListCardsBody),
      ArchiveListCardsBody: zodSchema(dto.archiveListCardsBody),
      CreateNoteBody: zodSchema(dto.createNoteBody),
      UpdateNoteBody: zodSchema(dto.updateNoteBody),
      MoveNoteBody: zodSchema(dto.moveNoteBody),
      CreateCardBody: zodSchema(dto.createCardBody),
      UpdateCardBody: zodSchema(dto.updateCardBody),
      SetCardCompletionBody: zodSchema(dto.setCardCompletionBody),
      BulkSetCardCompletionBody: zodSchema(dto.bulkSetCardCompletionBody),
      BulkSetCardDueDateBody: zodSchema(dto.bulkSetCardDueDateBody),
      BulkPatchCardLabelsBody: zodSchema(dto.bulkPatchCardLabelsBody),
      BulkPatchCardAssigneesBody: zodSchema(dto.bulkPatchCardAssigneesBody),
      BulkMoveCardsBody: zodSchema(dto.bulkMoveCardsBody),
      BulkArchiveCardsBody: zodSchema(dto.bulkArchiveCardsBody),
      BulkDuplicateCardsBody: zodSchema(dto.bulkDuplicateCardsBody),
      BulkSetCardCustomFieldBody: zodSchema(dto.bulkSetCardCustomFieldBody),
      MoveCardBody: zodSchema(dto.moveCardBody),
      DuplicateCardBody: zodSchema(dto.duplicateCardBody),
      MoveCardToBoardBody: zodSchema(dto.moveCardToBoardBody),
      SelectedCardContentQueryBody: zodSchema(dto.selectedCardContentQueryBody),
      SetCustomFieldValueBody: zodSchema(dto.setCustomFieldValueBody),
      CreateChecklistBody: zodSchema(dto.createChecklistBody),
      UpdateChecklistBody: zodSchema(dto.updateChecklistBody),
      MoveChecklistBody: zodSchema(dto.moveChecklistBody),
      CreateChecklistItemBody: zodSchema(dto.createChecklistItemBody),
      BulkCreateChecklistItemsBody: zodSchema(dto.bulkCreateChecklistItemsBody),
      UpdateChecklistItemBody: zodSchema(dto.updateChecklistItemBody),
      BulkUpdateChecklistItemsBody: zodSchema(dto.bulkUpdateChecklistItemsBody),
      BulkSetChecklistItemDescriptionsBody: zodSchema(dto.bulkSetChecklistItemDescriptionsBody),
      MoveChecklistItemBody: zodSchema(dto.moveChecklistItemBody),
      SetCardArchivedBody: zodSchema(dto.setCardArchivedBody),
      SetCardLabelsBody: zodSchema(dto.setCardLabelsBody),
      SetCardAssigneesBody: zodSchema(dto.setCardAssigneesBody),
      CreateCustomFieldBody: zodSchema(dto.createCustomFieldBody),
      UpdateCustomFieldBody: zodSchema(dto.updateCustomFieldBody),
      MoveCustomFieldBody: zodSchema(dto.moveCustomFieldBody),
      CreateCustomFieldOptionBody: zodSchema(dto.createCustomFieldOptionBody),
      UpdateCustomFieldOptionBody: zodSchema(dto.updateCustomFieldOptionBody),
      MoveCustomFieldOptionBody: zodSchema(dto.moveCustomFieldOptionBody),
      UpsertExternalLinkBody: zodSchema(dto.upsertExternalLinkBody),
      CreateCardLabelBody: zodSchema(dto.createCardLabelBody),
      UpdateCardLabelBody: zodSchema(dto.updateCardLabelBody),
      MoveCardLabelBody: zodSchema(dto.moveCardLabelBody),
      CreateCommentBody: zodSchema(dto.createCommentBody),
      BulkCreateCommentsBody: zodSchema(dto.bulkCreateCommentsBody),
      UpdateCommentBody: zodSchema(dto.updateCommentBody),
      BulkDeleteCommentsBody: zodSchema(dto.bulkDeleteCommentsBody),
      AddReactionBody: zodSchema(dto.addReactionBody),
    },
  },
  paths: {
    "/health": pathItem("get", operation({
      public: true,
      tags: ["Health"],
      summary: "Health check",
      operationId: "getPublicApiHealth",
      responses: { "200": ok(ref("Health")) },
    })),
    "/webhook-event-types": pathItem("get", operation({
      public: true,
      tags: ["Webhooks"],
      summary: "List webhook event types",
      description: "Returns the event type strings accepted in webhook endpoint `eventTypes`. Use this to populate an integration setup UI or validate a saved filter list. An empty webhook endpoint `eventTypes` configuration means all events.",
      operationId: "listWebhookEventTypes",
      responses: { "200": ok(ref("WebhookEventTypesResponse")) },
    })),
    "/api/media/{clientId}/{path}": pathItem("get", operation({
      public: true,
      tags: ["Media"],
      summary: "Read a signed media object",
      description: "Media URLs are returned by API responses with signed query parameters. Public API clients should use the URLs as returned rather than constructing them manually.",
      operationId: "getSignedMedia",
      parameters: [
        idParam("clientId", "Client/organisation id."),
        { name: "path", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: { "200": { description: "Media bytes." }, ...errorResponses },
    })),
    "/workspaces": {
      get: operation({
        tags: ["Workspaces"],
        summary: "List accessible workspaces",
        description: "Lists standard workspaces the credential can access at workspace scope. Personal keys and user OAuth tokens omit standalone-board hidden workspaces; a workspace-scoped key pinned to a standalone board still receives its own hidden workspace. Cross-organisation guests have access only to explicitly shared boards, so their parent workspaces are not returned here. Use `GET /home/boards` for complete board discovery, including standalone groups and `guestGroups`.",
        operationId: "listWorkspaces",
        responses: authedResponses({ "200": ok(arrayOf(ref("Workspace"))) }),
      }),
      post: operation({ tags: ["Workspaces"], summary: "Create a workspace", description: "Set `kind` to `board` and include `initialBoard` to create a standalone board. The server mirrors the initial board name, icon, and icon color onto its hidden workspace. Callers may seed `lists`, `customFields`, and `labels` from their chosen workflow.", operationId: "createWorkspace", requestBody: jsonBody(ref("CreateWorkspaceBody")), responses: authedResponses({ "201": created(ref("CreatedWorkspace")) }) }),
    },
    "/workspaces/{id}": {
      get: operation({ tags: ["Workspaces"], summary: "Get workspace details", operationId: "getWorkspace", parameters: [idParam()], responses: authedResponses({ "200": ok(ref("WorkspaceDetail")) }) }),
      patch: operation({ tags: ["Workspaces"], summary: "Update a workspace", operationId: "updateWorkspace", parameters: [idParam()], requestBody: jsonBody(ref("UpdateWorkspaceBody")), responses: authedResponses({ "200": ok(ref("Workspace")) }) }),
      delete: operation({ tags: ["Workspaces"], summary: "Delete a workspace", operationId: "deleteWorkspace", parameters: [idParam()], responses: authedResponses({ "204": noContent }) }),
    },
    "/workspaces/{id}/members": {
      get: operation({ tags: ["Workspaces"], summary: "List workspace members", operationId: "listWorkspaceMembers", parameters: [idParam()], responses: authedResponses({ "200": ok(arrayOf(ref("WorkspaceMember"))) }) }),
      post: operation({ tags: ["Workspaces"], summary: "Add a workspace member", operationId: "addWorkspaceMember", parameters: [idParam()], requestBody: jsonBody(ref("AddWorkspaceMemberBody")), responses: authedResponses({ "200": ok(ref("WorkspaceMember")) }) }),
    },
    "/workspaces/{id}/member-candidates": pathItem("get", operation({ tags: ["Workspaces"], summary: "List users that can be added to a workspace", operationId: "listWorkspaceMemberCandidates", parameters: [idParam()], responses: authedResponses({ "200": ok(arrayOf(ref("User"))) }) })),
    "/workspaces/{id}/members/{userId}": {
      patch: operation({ tags: ["Workspaces"], summary: "Update a workspace member role", operationId: "updateWorkspaceMember", parameters: [idParam(), idParam("userId")], requestBody: jsonBody(ref("UpdateWorkspaceMemberBody")), responses: authedResponses({ "200": ok(ref("WorkspaceMember")) }) }),
      delete: operation({ tags: ["Workspaces"], summary: "Remove a workspace member", operationId: "removeWorkspaceMember", parameters: [idParam(), idParam("userId")], responses: authedResponses({ "204": noContent }) }),
    },
    "/workspaces/{id}/external-links": {
      get: operation({
        tags: ["External Links"],
        summary: "List external links",
        description: "Find Kanera entities linked to records in an external system. Filtering by `provider`, `externalType`, and `externalId` returns the mapping a sync job typically needs before deciding whether to create or update a Kanera entity.",
        operationId: "listExternalLinks",
        parameters: [
          idParam(),
          queryParam("provider", { type: "string" }),
          queryParam("externalType", { type: "string" }),
          queryParam("externalId", { type: "string" }),
          queryParam("entityType", { type: "string", enum: ["card", "comment", "cardAttachment", "cardChecklist", "cardChecklistItem"] }),
          queryParam("entityId", uuid),
          queryParam("limit", { type: "integer", minimum: 1, maximum: 500, default: 100 }),
        ],
        responses: authedResponses({ "200": ok(arrayOf(ref("ExternalLink"))) }),
      }),
      post: operation({
        tags: ["External Links"],
        summary: "Create or update an external link",
        description: "Upserts a durable mapping from an external record to a Kanera entity. Use this after creating or matching a Kanera record so future sync runs are idempotent. The target entity must belong to the workspace.",
        operationId: "upsertExternalLink",
        parameters: [idParam()],
        requestBody: jsonBody(ref("UpsertExternalLinkBody")),
        responses: authedResponses({ "200": ok(ref("ExternalLink")) }),
      }),
    },
    "/workspaces/{workspaceId}/external-links/{linkId}": {
      get: operation({ tags: ["External Links"], summary: "Get an external link", operationId: "getExternalLink", parameters: [idParam("workspaceId"), idParam("linkId")], responses: authedResponses({ "200": ok(ref("ExternalLink")) }) }),
      delete: operation({ tags: ["External Links"], summary: "Delete an external link", operationId: "deleteExternalLink", parameters: [idParam("workspaceId"), idParam("linkId")], responses: authedResponses({ "204": noContent }) }),
    },
    "/workspaces/{id}/boards": {
      get: operation({
        tags: ["Workspaces"],
        summary: "List workspace boards",
        description: "Use this after listing workspaces to find board ids. Board ids are needed for opening board detail, creating cards, and working with board notes.",
        operationId: "listWorkspaceBoards",
        parameters: [idParam()],
        responses: authedResponses({ "200": ok(arrayOf(ref("Board"))) }),
      }),
      post: operation({ tags: ["Boards"], summary: "Create a board", description: "Creates a board in a standard workspace. Standalone-board workspaces reject a second board.", operationId: "createBoard", parameters: [idParam("id", "Workspace id.")], requestBody: jsonBody(ref("CreateBoardBody")), responses: authedResponses({ "201": created(ref("Board")) }) }),
    },
    "/home/boards": pathItem("get", operation({
      tags: ["Workspaces"],
      summary: "Discover accessible and guest boards",
      description: "Returns boards grouped by parent workspace. `groups` contains boards reached through workspace-level access; groups whose `workspace.kind` is `board` represent standalone boards. For personal keys and user OAuth tokens, `guestGroups` contains boards in other organisations that were explicitly shared with the credential owner. A guest group's workspace metadata is display and grouping context only; guest permission remains limited to the boards in that group's `boards` array. Workspace-scoped keys return only their pinned workspace in `groups`.",
      operationId: "listHomeBoards",
      responses: authedResponses({ "200": ok(ref("HomeBoardsPage")) }),
    })),
    "/boards/{id}": {
      get: operation({ tags: ["Boards"], summary: "Get a board", description: "Returns the lightweight board row without hydrating cards or workspace settings.", operationId: "getBoard", parameters: [idParam()], responses: authedResponses({ "200": ok(ref("Board")) }) }),
      patch: operation({ tags: ["Boards"], summary: "Update a board", description: "For a standalone board, name, icon, and icon color are also mirrored onto its hidden workspace.", operationId: "updateBoard", parameters: [idParam()], requestBody: jsonBody(ref("UpdateBoardBody")), responses: authedResponses({ "200": ok(ref("Board")) }) }),
      delete: operation({ tags: ["Boards"], summary: "Delete a board", description: "Deleting a standalone board also deletes its hidden workspace and all workspace-scoped configuration. Deleting a standard board leaves its workspace intact.", operationId: "deleteBoard", parameters: [idParam()], responses: authedResponses({ "204": noContent }) }),
    },
    "/boards/{id}/open": pathItem("post", operation({
      tags: ["Boards"],
      summary: "Open board detail",
      description: "Returns board metadata and workspace-scoped configuration. Set `includeCards=false` for metadata only. To include cards, both `listId` and `cardLimit` are required; at most 100 cards from that one list are returned, with `cardPage.hasMore` indicating whether to request the next offset.",
      operationId: "openBoard",
      parameters: [
        idParam(),
        queryParam("includeCompleted", { type: "boolean" }, "Include completed cards."),
        queryParam("archived", { type: "boolean" }, "Return archived cards."),
        queryParam("includeCards", { type: "boolean", default: true }, "Set false to omit cards and skip card hydration. Otherwise listId and cardLimit are required."),
        queryParam("listId", uuid, "Return cards only from this workflow list."),
        queryParam("cardLimit", { type: "integer", minimum: 1, maximum: 100 }, "Maximum cards returned in this page."),
        queryParam("cardOffset", { type: "integer", minimum: 0, default: 0 }, "Card row offset within the selected list."),
      ],
      responses: authedResponses({ "200": ok(ref("BoardDetail")) }),
    })),
    "/boards/{id}/move": pathItem("post", operation({ tags: ["Boards"], summary: "Move a board", operationId: "moveBoard", parameters: [idParam()], requestBody: jsonBody(ref("MoveBoardBody")), responses: authedResponses({ "200": ok(ref("Board")) }) })),
    "/boards/{id}/background": pathItem("patch", operation({ tags: ["Boards"], summary: "Update board background", operationId: "updateBoardBackground", parameters: [idParam()], requestBody: jsonBody(ref("UpdateBoardBackgroundBody")), responses: authedResponses({ "200": ok(ref("Board")) }) })),
    "/boards/{id}/transfer-targets": pathItem("get", operation({ tags: ["Boards"], summary: "List accessible card transfer targets", operationId: "listBoardTransferTargets", parameters: [idParam()], responses: authedResponses({ "200": ok(arrayOf(ref("Board"))) }) })),
    "/boards/{id}/members": {
      get: operation({ tags: ["Board Access"], summary: "List board members", description: "Returns explicit board permissions plus inherited pinned administrators. Requires board-management access.", operationId: "listBoardMembers", parameters: [idParam()], responses: authedResponses({ "200": ok(arrayOf(ref("BoardMember"))) }) }),
      post: operation({ tags: ["Board Access"], summary: "Add a board member", description: "Grants an existing user explicit board permission. Standalone boards accept active organisation members directly; cross-organisation guests remain subject to guest entitlement and seat limits.", operationId: "addBoardMember", parameters: [idParam()], requestBody: jsonBody(ref("AddBoardMemberBody")), responses: authedResponses({ "201": created(ref("BoardMember")) }) }),
    },
    "/boards/{id}/member-candidates": pathItem("get", operation({
      tags: ["Board Access"],
      summary: "List board member candidates",
      description: "Returns workspace members for standard boards and organisation members for standalone boards, identified by the response `scope`.",
      operationId: "listBoardMemberCandidates",
      parameters: [idParam()],
      responses: authedResponses({ "200": ok(ref("BoardMemberCandidates")) }),
    })),
    "/boards/{id}/members/{userId}": {
      patch: operation({ tags: ["Board Access"], summary: "Update a board member", description: "Changes an explicit board permission. Pinned inherited administrators cannot be changed here.", operationId: "updateBoardMember", parameters: [idParam(), idParam("userId")], requestBody: jsonBody(ref("UpdateBoardMemberBody")), responses: authedResponses({ "200": ok(ref("BoardMember")) }) }),
      delete: operation({ tags: ["Board Access"], summary: "Remove a board member", description: "Removes explicit board access and cleans up board participation. Pinned inherited administrators cannot be removed here.", operationId: "removeBoardMember", parameters: [idParam(), idParam("userId")], responses: authedResponses({ "204": noContent }) }),
    },
    "/workspaces/{id}/guests": pathItem("get", operation({
      tags: ["Board Access"],
      summary: "List workspace board guests",
      description: "Lists accepted cross-organisation guests and pending invitations. For a standalone board, use the workspace id returned alongside the board by `GET /home/boards` or standalone creation.",
      operationId: "listWorkspaceBoardGuests",
      parameters: [idParam()],
      responses: authedResponses({ "200": ok(ref("StandaloneBoardGuests")) }),
    })),
    "/workspaces/{id}/guests/seat-preview": pathItem("post", operation({
      tags: ["Board Access"],
      summary: "Preview guest seat usage",
      description: "Checks whether granting one board to an existing cross-organisation user would require a paid guest seat. The invitation mutation repeats this check transactionally.",
      operationId: "previewBoardGuestSeat",
      parameters: [idParam()],
      requestBody: jsonBody(ref("StandaloneBoardGuestInvitationBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["paidGuestSeatRequired", "paidGuestSeatActive"], properties: { paidGuestSeatRequired: { type: "boolean" }, paidGuestSeatActive: { type: "boolean" } } }) }),
    })),
    "/workspaces/{id}/guests/invitations": pathItem("post", operation({
      tags: ["Board Access"],
      summary: "Invite a board guest",
      description: "Invites a cross-organisation guest by email. Existing Kanera users receive access immediately; new users receive an invitation. Guest plan, domain, free-board allowance, and paid-seat limits are enforced by the server.",
      operationId: "inviteBoardGuest",
      parameters: [idParam()],
      requestBody: jsonBody(ref("StandaloneBoardGuestInvitationBody")),
      responses: authedResponses({ "201": created({ type: "object", additionalProperties: true }) }),
    })),
    "/workspaces/{id}/guests/invitations/{invitationId}": pathItem("delete", operation({
      tags: ["Board Access"],
      summary: "Revoke a board guest invitation",
      operationId: "revokeBoardGuestInvitation",
      parameters: [idParam(), idParam("invitationId")],
      responses: authedResponses({ "204": noContent }),
    })),
    "/workspaces/{id}/guests/{boardId}/{userId}": pathItem("delete", operation({
      tags: ["Board Access"],
      summary: "Remove an accepted board guest",
      description: "Removes a cross-organisation guest and releases any no-longer-needed paid guest seat without reducing the purchased seat limit.",
      operationId: "removeBoardGuest",
      parameters: [idParam(), idParam("boardId"), idParam("userId")],
      responses: authedResponses({ "204": noContent }),
    })),
    "/workspaces/{workspaceId}/assignees/cards": pathItem("get", operation({ tags: ["Assigned Work"], summary: "List cards assigned to all teammates", operationId: "listTeamAssignedCards", parameters: [idParam("workspaceId")], responses: authedResponses({ "200": ok(ref("AssignedCardsPage")) }) })),
    "/workspaces/{workspaceId}/assignees/{userId}/cards": pathItem("get", operation({ tags: ["Assigned Work"], summary: "List cards assigned to a user", operationId: "listAssignedCards", parameters: [idParam("workspaceId"), idParam("userId")], responses: authedResponses({ "200": ok(ref("AssignedCardsPage")) }) })),
    "/workspaces/{wsId}/lists": pathItem("post", operation({ tags: ["Lists"], summary: "Create a workspace list", operationId: "createList", parameters: [idParam("wsId", "Workspace id.")], requestBody: jsonBody(ref("CreateListBody")), responses: authedResponses({ "201": created(ref("List")) }) })),
    "/lists/{id}": {
      patch: operation({ tags: ["Lists"], summary: "Update a list", operationId: "updateList", parameters: [idParam()], requestBody: jsonBody(ref("UpdateListBody")), responses: authedResponses({ "200": ok(ref("List")) }) }),
      delete: operation({ tags: ["Lists"], summary: "Archive a list", operationId: "archiveList", parameters: [idParam()], responses: authedResponses({ "204": noContent }) }),
    },
    "/lists/{id}/cards/move": pathItem("post", operation({ tags: ["Lists"], summary: "Move cards between lists in bulk", operationId: "moveListCards", parameters: [idParam()], requestBody: jsonBody(ref("MoveListCardsBody")), responses: authedResponses({ "200": ok({ type: "object", required: ["moved"], properties: { moved: { type: "integer" } } }) }) })),
    "/lists/{id}/cards/archive": pathItem("patch", operation({ tags: ["Lists"], summary: "Archive cards in a list", operationId: "archiveListCards", parameters: [idParam()], requestBody: jsonBody(ref("ArchiveListCardsBody")), responses: authedResponses({ "200": ok({ type: "object", properties: { archived: { type: "integer" } }, required: ["archived"] }) }) })),
    "/lists/{id}/move": pathItem("post", operation({ tags: ["Lists"], summary: "Move a list", operationId: "moveList", parameters: [idParam()], requestBody: jsonBody(ref("MoveListBody")), responses: authedResponses({ "200": ok(ref("List")) }) })),
    "/workspaces/{wsId}/notes": {
      get: operation({ tags: ["Notes"], summary: "List workspace notes", operationId: "listWorkspaceNotes", parameters: [idParam("wsId"), ...paginationParams], responses: authedResponses({ "200": ok(ref("NotePage")) }) }),
      post: operation({ tags: ["Notes"], summary: "Create a workspace note", operationId: "createWorkspaceNote", parameters: [idParam("wsId")], requestBody: jsonBody(ref("CreateNoteBody")), responses: authedResponses({ "201": created(ref("Note")) }) }),
    },
    "/boards/{boardId}/notes": {
      get: operation({ tags: ["Notes"], summary: "List board notes", operationId: "listBoardNotes", parameters: [idParam("boardId"), ...paginationParams], responses: authedResponses({ "200": ok(ref("NotePage")) }) }),
      post: operation({ tags: ["Notes"], summary: "Create a board note", operationId: "createBoardNote", parameters: [idParam("boardId")], requestBody: jsonBody(ref("CreateNoteBody")), responses: authedResponses({ "201": created(ref("Note")) }) }),
    },
    "/notes/{id}": {
      get: operation({ tags: ["Notes"], summary: "Get a note", operationId: "getNote", parameters: [idParam()], responses: authedResponses({ "200": ok(ref("Note")) }) }),
      patch: operation({ tags: ["Notes"], summary: "Update a note", operationId: "updateNote", parameters: [idParam()], requestBody: jsonBody(ref("UpdateNoteBody")), responses: authedResponses({ "200": ok(ref("Note")) }) }),
      delete: operation({ tags: ["Notes"], summary: "Delete a note", operationId: "deleteNote", parameters: [idParam()], responses: authedResponses({ "204": noContent }) }),
    },
    "/notes/{id}/move": pathItem("patch", operation({ tags: ["Notes"], summary: "Move a note between workspace and board scopes", operationId: "moveNote", parameters: [idParam()], requestBody: jsonBody(ref("MoveNoteBody")), responses: authedResponses({ "200": ok(ref("Note")) }) })),
    "/notes/{id}/attachments": pathItem("post", operation({ tags: ["Notes"], summary: "Upload an embedded note attachment", operationId: "uploadNoteAttachment", parameters: [idParam()], requestBody: multipartBody("Upload a single note attachment file."), responses: authedResponses({ "201": created(ref("CardAttachment")) }) })),
    "/notes/{id}/lock": pathItem("post", operation({ tags: ["Notes"], summary: "Lock a note for editing", operationId: "lockNote", parameters: [idParam()], responses: authedResponses({ "200": ok(ref("Note")) }) })),
    "/notes/{id}/unlock": pathItem("post", operation({ tags: ["Notes"], summary: "Unlock a note", operationId: "unlockNote", parameters: [idParam()], responses: authedResponses({ "204": noContent }) })),
    "/cards/{id}/detail": pathItem("get", operation({ tags: ["Cards"], summary: "Get full card detail", operationId: "getCardDetail", parameters: [idParam()], responses: authedResponses({ "200": ok(ref("CardDetail")) }) })),
    "/boards/{boardId}/cards/content/query": pathItem("post", operation({
      tags: ["Cards"],
      summary: "Get checklist and comment content for selected cards",
      description: "Returns only the card, checklist, and comment content needed for bounded audits and migrations, preserving the requested card order. Best-effort: requested ids that are not on this board (or not visible to the caller) are returned in missingCardIds rather than failing the request, and any card whose comment history exceeds the per-card cap is listed in truncatedCardIds (page its full history via GET /cards/{id}/comments). Comments here omit reactions and attachment metadata.",
      operationId: "getSelectedCardContent",
      parameters: [idParam("boardId")],
      requestBody: jsonBody(ref("SelectedCardContentQueryBody")),
      responses: authedResponses({ "200": ok({
        type: "object",
        required: ["cards", "missingCardIds", "truncatedCardIds"],
        properties: {
          cards: arrayOf({
            type: "object",
            required: ["card", "checklists", "comments"],
            properties: {
              card: ref("Card"),
              checklists: arrayOf(ref("Checklist")),
              comments: arrayOf(ref("ContentQueryComment")),
            },
          }),
          missingCardIds: arrayOf(uuid),
          truncatedCardIds: arrayOf(uuid),
        },
      }) }),
    })),
    "/boards/{boardId}/lists/{id}/cards": pathItem("post", operation({
      tags: ["Cards"],
      summary: "Create a card",
      description: "Creates a card on a board in one of the workspace's shared lists. Use the list ids returned by opening the board or workspace detail.",
      operationId: "createCard",
      parameters: [idParam("boardId"), idParam("id", "List id.")],
      requestBody: jsonBody(ref("CreateCardBody")),
      responses: authedResponses({ "201": created(ref("Card")) }),
    })),
    "/boards/{boardId}/lists/{id}/cards/completion": pathItem("post", operation({ tags: ["Cards"], summary: "Set completion for all cards in a list", operationId: "setListCardCompletion", parameters: [idParam("boardId"), idParam("id", "List id.")], requestBody: jsonBody(ref("SetCardCompletionBody")), responses: authedResponses({ "200": ok({ type: "object", required: ["updated"], properties: { updated: { type: "integer" } } }) }) })),
    "/boards/{boardId}/cards/bulk/completion": pathItem("patch", operation({
      tags: ["Cards"], summary: "Set completion on selected cards", operationId: "bulkSetCardCompletion", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkSetCardCompletionBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["updated", "cards", "skippedCardIds"], properties: { updated: { type: "integer" }, cards: arrayOf(ref("Card")), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/cards/bulk/due-date": pathItem("patch", operation({
      tags: ["Cards"], summary: "Set a due date on selected cards", operationId: "bulkSetCardDueDate", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkSetCardDueDateBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["updated", "cards", "skippedCardIds"], properties: { updated: { type: "integer" }, cards: arrayOf(ref("Card")), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/cards/bulk/labels": pathItem("patch", operation({
      tags: ["Cards"], summary: "Add or remove labels on selected cards", operationId: "bulkPatchCardLabels", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkPatchCardLabelsBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["updated", "updatedCardIds", "skippedCardIds"], properties: { updated: { type: "integer" }, updatedCardIds: arrayOf(uuid), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/cards/bulk/assignees": pathItem("patch", operation({
      tags: ["Cards"], summary: "Add or remove assignees on selected cards", operationId: "bulkPatchCardAssignees", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkPatchCardAssigneesBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["updated", "updatedCardIds", "skippedCardIds"], properties: { updated: { type: "integer" }, updatedCardIds: arrayOf(uuid), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/cards/bulk/move": pathItem("post", operation({
      tags: ["Cards"], summary: "Move selected cards to a list", operationId: "bulkMoveCards", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkMoveCardsBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["moved", "cards", "skippedCardIds"], properties: { moved: { type: "integer" }, cards: arrayOf(ref("Card")), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/cards/bulk/archive": pathItem("patch", operation({
      tags: ["Cards"], summary: "Archive selected cards", operationId: "bulkArchiveCards", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkArchiveCardsBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["archived", "cards", "skippedCardIds"], properties: { archived: { type: "integer" }, cards: arrayOf(ref("Card")), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/cards/bulk/duplicate": pathItem("post", operation({
      tags: ["Cards"], summary: "Duplicate selected cards", operationId: "bulkDuplicateCards", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkDuplicateCardsBody")),
      responses: authedResponses({ "201": created({ type: "object", required: ["duplicated", "cards", "skippedCardIds"], properties: { duplicated: { type: "integer" }, cards: arrayOf(ref("Card")), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/cards/bulk/custom-fields": pathItem("patch", operation({
      tags: ["Cards"], summary: "Set one custom field on selected cards", operationId: "bulkSetCardCustomField", parameters: [idParam("boardId")], requestBody: jsonBody(ref("BulkSetCardCustomFieldBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["updated", "values", "clearedCardIds", "skippedCardIds"], properties: { updated: { type: "integer" }, values: arrayOf(ref("CustomFieldValue")), clearedCardIds: arrayOf(uuid), skippedCardIds: arrayOf(uuid) } }) }),
    })),
    "/cards/{id}": pathItem("patch", operation({
      tags: ["Cards"],
      summary: "Update a card",
      description: "Updates core card fields such as title, description, and due date. Use the dedicated card endpoints for labels, assignees, custom fields, movement, completion, and attachments.",
      operationId: "updateCard",
      parameters: [idParam()],
      requestBody: jsonBody(ref("UpdateCardBody")),
      responses: authedResponses({ "200": ok(ref("Card")) }),
    })),
    "/cards/{id}/completion": pathItem("patch", operation({ tags: ["Cards"], summary: "Set card completion", operationId: "setCardCompletion", parameters: [idParam()], requestBody: jsonBody(ref("SetCardCompletionBody")), responses: authedResponses({ "200": ok(ref("Card")) }) })),
    "/cards/{id}/move": pathItem("post", operation({ tags: ["Cards"], summary: "Move a card", operationId: "moveCard", parameters: [idParam()], requestBody: jsonBody(ref("MoveCardBody")), responses: authedResponses({ "200": ok(ref("Card")) }) })),
    "/cards/{id}/duplicate": pathItem("post", operation({ tags: ["Cards"], summary: "Duplicate a card", operationId: "duplicateCard", parameters: [idParam()], requestBody: jsonBody(ref("DuplicateCardBody")), responses: authedResponses({ "201": created(ref("Card")) }) })),
    "/cards/{id}/move-to-board": pathItem("post", operation({ tags: ["Cards"], summary: "Move a card to another board", operationId: "moveCardToBoard", parameters: [idParam()], requestBody: jsonBody(ref("MoveCardToBoardBody")), responses: authedResponses({ "200": ok(ref("Card")) }) })),
    "/cards/{id}/custom-fields/{fieldId}": {
      put: operation({ tags: ["Cards"], summary: "Set a card custom field value", operationId: "setCardCustomFieldValue", parameters: [idParam(), idParam("fieldId")], requestBody: jsonBody(ref("SetCustomFieldValueBody")), responses: authedResponses({ "200": ok(ref("CustomFieldValue")) }) }),
      delete: operation({ tags: ["Cards"], summary: "Clear a card custom field value", operationId: "clearCardCustomFieldValue", parameters: [idParam(), idParam("fieldId")], responses: authedResponses({ "204": noContent }) }),
    },
    "/cards/{id}/checklists": pathItem("post", operation({ tags: ["Cards"], summary: "Create a card-level or one-level sub-checklist", operationId: "createChecklist", parameters: [idParam()], requestBody: jsonBody(ref("CreateChecklistBody")), responses: authedResponses({ "201": created(ref("Checklist")) }) })),
    "/cards/{id}/checklists/{checklistId}": {
      patch: operation({ tags: ["Cards"], summary: "Update a checklist", operationId: "updateChecklist", parameters: [idParam(), idParam("checklistId")], requestBody: jsonBody(ref("UpdateChecklistBody")), responses: authedResponses({ "200": ok(ref("Checklist")) }) }),
      delete: operation({ tags: ["Cards"], summary: "Delete a checklist", operationId: "deleteChecklist", parameters: [idParam(), idParam("checklistId")], responses: authedResponses({ "204": noContent }) }),
    },
    "/cards/{id}/checklists/{checklistId}/move": pathItem("post", operation({ tags: ["Cards"], summary: "Move a checklist", operationId: "moveChecklist", parameters: [idParam(), idParam("checklistId")], requestBody: jsonBody(ref("MoveChecklistBody")), responses: authedResponses({ "200": ok(ref("Checklist")) }) })),
    "/cards/{id}/checklists/{checklistId}/items": pathItem("post", operation({ tags: ["Cards"], summary: "Create a checklist item", operationId: "createChecklistItem", parameters: [idParam(), idParam("checklistId")], requestBody: jsonBody(ref("CreateChecklistItemBody")), responses: authedResponses({ "201": created(ref("ChecklistItem")) }) })),
    "/boards/{boardId}/checklist-items/bulk/create": pathItem("post", operation({
      tags: ["Cards"],
      summary: "Create selected checklist items in bulk",
      description: "Atomically creates up to 200 items across checklists and cards in one board. Results preserve request order. This operation is not idempotent.",
      operationId: "bulkCreateChecklistItems",
      parameters: [idParam("boardId")],
      requestBody: jsonBody(ref("BulkCreateChecklistItemsBody")),
      responses: authedResponses({ "201": created({ type: "object", required: ["created", "items"], properties: { created: { type: "integer" }, items: arrayOf(ref("ChecklistItem")) } }) }),
    })),
    "/cards/{id}/checklists/{checklistId}/items/bulk": pathItem("patch", operation({
      tags: ["Cards"],
      summary: "Set the assignee or due date on every item in a checklist",
      operationId: "bulkUpdateChecklistItems",
      parameters: [idParam(), idParam("checklistId")],
      requestBody: jsonBody(ref("BulkUpdateChecklistItemsBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["items"], properties: { items: arrayOf(ref("ChecklistItem")) } }) }),
    })),
    "/boards/{boardId}/checklist-items/bulk/descriptions": pathItem("patch", operation({
      tags: ["Cards"],
      summary: "Set selected checklist-item descriptions in bulk",
      description: "Atomically validates and updates up to 200 top-level checklist items across cards in one board. Repeated values are returned as unchanged without new activity.",
      operationId: "bulkSetChecklistItemDescriptions",
      parameters: [idParam("boardId")],
      requestBody: jsonBody(ref("BulkSetChecklistItemDescriptionsBody")),
      responses: authedResponses({ "200": ok({
        type: "object",
        required: ["updated", "items", "unchangedItemIds"],
        properties: {
          updated: { type: "integer" },
          items: arrayOf({
            type: "object",
            required: ["cardId", "checklistId", "item"],
            properties: { cardId: uuid, checklistId: uuid, item: ref("ChecklistItem") },
          }),
          unchangedItemIds: arrayOf(uuid),
        },
      }) }),
    })),
    "/cards/{id}/checklists/{checklistId}/items/{itemId}": {
      patch: operation({ tags: ["Cards"], summary: "Update a checklist item, including its description", operationId: "updateChecklistItem", parameters: [idParam(), idParam("checklistId"), idParam("itemId")], requestBody: jsonBody(ref("UpdateChecklistItemBody")), responses: authedResponses({ "200": ok(ref("ChecklistItem")) }) }),
      delete: operation({ tags: ["Cards"], summary: "Delete a checklist item", operationId: "deleteChecklistItem", parameters: [idParam(), idParam("checklistId"), idParam("itemId")], responses: authedResponses({ "204": noContent }) }),
    },
    "/cards/{id}/checklists/{checklistId}/items/{itemId}/move": pathItem("post", operation({ tags: ["Cards"], summary: "Move a checklist item", operationId: "moveChecklistItem", parameters: [idParam(), idParam("checklistId"), idParam("itemId")], requestBody: jsonBody(ref("MoveChecklistItemBody")), responses: authedResponses({ "200": ok(ref("ChecklistItem")) }) })),
    "/cards/{id}/archive": pathItem("patch", operation({ tags: ["Cards"], summary: "Archive or restore a card", operationId: "setCardArchived", parameters: [idParam()], requestBody: jsonBody(ref("SetCardArchivedBody")), responses: authedResponses({ "200": ok(ref("Card")) }) })),
    "/cards/{id}/labels": pathItem("put", operation({ tags: ["Cards"], summary: "Replace card labels", operationId: "setCardLabels", parameters: [idParam()], requestBody: jsonBody(ref("SetCardLabelsBody")), responses: authedResponses({ "200": ok(ref("CardDetail")) }) })),
    "/cards/{id}/assignees": pathItem("put", operation({ tags: ["Cards"], summary: "Replace card assignees", operationId: "setCardAssignees", parameters: [idParam()], requestBody: jsonBody(ref("SetCardAssigneesBody")), responses: authedResponses({ "200": ok(ref("CardDetail")) }) })),
    "/cards/{id}/attachments": {
      get: operation({ tags: ["Attachments"], summary: "List card attachments", operationId: "listCardAttachments", parameters: [idParam()], responses: authedResponses({ "200": ok(arrayOf(ref("CardAttachment"))) }) }),
      post: operation({
        tags: ["Attachments"],
        summary: "Upload a card attachment",
        description: "Upload a file to a card. For inline images in descriptions or comments, upload the image first, use the returned `url` in Markdown/HTML, then save the description or comment. Integration requests are rejected if inline media points at a non-Kanera URL. Use `source=description` for description embeds and `source=comment` with `attachmentIds` on comment creation/update for comment embeds.",
        operationId: "uploadCardAttachment",
        parameters: [
          idParam(),
          queryParam("source", { type: "string", enum: ["description", "attachment", "comment"], default: "attachment" }),
          queryParam("commentId", uuid, "Existing comment id to attach to. Usually omit this and pass returned attachment ids in `attachmentIds` when creating or updating a comment."),
        ],
        requestBody: multipartBody("Upload a single card attachment file."),
        responses: authedResponses({ "201": created(ref("CardAttachment")) }),
      }),
    },
    "/cards/{id}/cover": pathItem("patch", operation({ tags: ["Attachments"], summary: "Set or clear a card cover image", operationId: "setCardCover", parameters: [idParam()], requestBody: jsonBody({ type: "object", properties: { attachmentId: nullable(uuid) } }), responses: authedResponses({ "200": ok(ref("CardDetail")) }) })),
    "/cards/{id}/attachments/{attachmentId}": pathItem("delete", operation({ tags: ["Attachments"], summary: "Delete a card attachment", operationId: "deleteCardAttachment", parameters: [idParam(), idParam("attachmentId")], responses: authedResponses({ "204": noContent }) })),
    "/workspaces/{wsId}/custom-fields": pathItem("post", operation({ tags: ["Custom Fields"], summary: "Create a custom field", operationId: "createCustomField", parameters: [idParam("wsId")], requestBody: jsonBody(ref("CreateCustomFieldBody")), responses: authedResponses({ "201": created(ref("CustomField")) }) })),
    "/custom-fields/{id}": {
      patch: operation({ tags: ["Custom Fields"], summary: "Update a custom field", operationId: "updateCustomField", parameters: [idParam()], requestBody: jsonBody(ref("UpdateCustomFieldBody")), responses: authedResponses({ "200": ok(ref("CustomField")) }) }),
      delete: operation({ tags: ["Custom Fields"], summary: "Archive a custom field", operationId: "archiveCustomField", parameters: [idParam()], responses: authedResponses({ "204": noContent }) }),
    },
    "/custom-fields/{id}/move": pathItem("post", operation({ tags: ["Custom Fields"], summary: "Move a custom field", operationId: "moveCustomField", parameters: [idParam()], requestBody: jsonBody(ref("MoveCustomFieldBody")), responses: authedResponses({ "200": ok(ref("CustomField")) }) })),
    "/custom-fields/{id}/options": pathItem("post", operation({ tags: ["Custom Fields"], summary: "Add a select field option", operationId: "createCustomFieldOption", parameters: [idParam()], requestBody: jsonBody(ref("CreateCustomFieldOptionBody")), responses: authedResponses({ "201": created(ref("CustomFieldOption")) }) })),
    "/options/{optionId}": {
      patch: operation({ tags: ["Custom Fields"], summary: "Update a select field option", operationId: "updateCustomFieldOption", parameters: [idParam("optionId")], requestBody: jsonBody(ref("UpdateCustomFieldOptionBody")), responses: authedResponses({ "200": ok(ref("CustomFieldOption")) }) }),
      delete: operation({ tags: ["Custom Fields"], summary: "Archive a select field option", operationId: "archiveCustomFieldOption", parameters: [idParam("optionId")], responses: authedResponses({ "204": noContent }) }),
    },
    "/options/{optionId}/move": pathItem("post", operation({ tags: ["Custom Fields"], summary: "Move a select field option", operationId: "moveCustomFieldOption", parameters: [idParam("optionId")], requestBody: jsonBody(ref("MoveCustomFieldOptionBody")), responses: authedResponses({ "200": ok(ref("CustomFieldOption")) }) })),
    "/workspaces/{wsId}/card-labels": pathItem("post", operation({ tags: ["Card Labels"], summary: "Create a card label", operationId: "createCardLabel", parameters: [idParam("wsId")], requestBody: jsonBody(ref("CreateCardLabelBody")), responses: authedResponses({ "201": created(ref("CardLabel")) }) })),
    "/card-labels/{id}": {
      patch: operation({ tags: ["Card Labels"], summary: "Update a card label", operationId: "updateCardLabel", parameters: [idParam()], requestBody: jsonBody(ref("UpdateCardLabelBody")), responses: authedResponses({ "200": ok(ref("CardLabel")) }) }),
      delete: operation({ tags: ["Card Labels"], summary: "Delete a card label", operationId: "deleteCardLabel", parameters: [idParam()], responses: authedResponses({ "204": noContent }) }),
    },
    "/card-labels/{id}/move": pathItem("post", operation({ tags: ["Card Labels"], summary: "Move a card label", operationId: "moveCardLabel", parameters: [idParam()], requestBody: jsonBody(ref("MoveCardLabelBody")), responses: authedResponses({ "200": ok(ref("CardLabel")) }) })),
    "/cards/{id}/feed": pathItem("get", operation({ tags: ["Comments"], summary: "List card feed items", operationId: "listCardFeed", parameters: [idParam(), ...paginationParams], responses: authedResponses({ "200": ok(ref("CardFeedPage")) }) })),
    "/cards/{id}/comments": {
      get: operation({ tags: ["Comments"], summary: "List card comments", operationId: "listCardComments", parameters: [idParam(), ...paginationParams], responses: authedResponses({ "200": ok(ref("CommentPage")) }) }),
      post: operation({ tags: ["Comments"], summary: "Create a card comment", operationId: "createComment", parameters: [idParam()], requestBody: jsonBody(ref("CreateCommentBody")), responses: authedResponses({ "201": created(ref("Comment")) }) }),
    },
    "/comments/{id}": {
      patch: operation({ tags: ["Comments"], summary: "Update a comment", operationId: "updateComment", parameters: [idParam()], requestBody: jsonBody(ref("UpdateCommentBody")), responses: authedResponses({ "200": ok(ref("Comment")) }) }),
      delete: operation({ tags: ["Comments"], summary: "Delete a comment", operationId: "deleteComment", parameters: [idParam()], responses: authedResponses({ "204": noContent }) }),
    },
    "/boards/{boardId}/comments/bulk/delete": pathItem("post", operation({
      tags: ["Comments"],
      summary: "Delete selected comments authored by the acting user",
      description: "Atomically deletes up to 200 comments only when every comment belongs to this board and was authored by the acting user. Attachments remain on their cards.",
      operationId: "bulkDeleteComments",
      parameters: [idParam("boardId")],
      requestBody: jsonBody(ref("BulkDeleteCommentsBody")),
      responses: authedResponses({ "200": ok({ type: "object", required: ["deleted", "commentIds"], properties: { deleted: { type: "integer" }, commentIds: arrayOf(uuid) } }) }),
    })),
    "/boards/{boardId}/comments/bulk/create": pathItem("post", operation({
      tags: ["Comments"],
      summary: "Create selected comments in bulk",
      description: "Atomically creates up to 200 text comments across cards in one board. Attachments are not accepted. Results preserve request order. This operation is not idempotent.",
      operationId: "bulkCreateComments",
      parameters: [idParam("boardId")],
      requestBody: jsonBody(ref("BulkCreateCommentsBody")),
      responses: authedResponses({ "201": created({ type: "object", required: ["created", "comments"], properties: { created: { type: "integer" }, comments: arrayOf(ref("Comment")) } }) }),
    })),
    "/comments/{id}/reactions": pathItem("post", operation({ tags: ["Comments"], summary: "Add a comment reaction", operationId: "addCommentReaction", parameters: [idParam()], requestBody: jsonBody(ref("AddReactionBody")), responses: authedResponses({ "201": created(ref("Comment")) }) })),
    "/comments/{id}/reactions/{type}": pathItem("delete", operation({ tags: ["Comments"], summary: "Remove a comment reaction", operationId: "removeCommentReaction", parameters: [idParam(), { name: "type", in: "path", required: true, schema: { type: "string" } }], responses: authedResponses({ "204": noContent }) })),
    "/boards/{id}/activity": pathItem("get", operation({ tags: ["Activity"], summary: "List board activity", operationId: "listBoardActivity", parameters: [idParam(), ...paginationParams], responses: authedResponses({ "200": ok(ref("ActivityPage")) }) })),
  },
};

export function getPublicOpenApiDocument() {
  return publicOpenApiDocument;
}
