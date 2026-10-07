# E2E coverage map

This file describes the user flows and failures covered by each E2E spec. Update it when adding or changing coverage.

| Spec | Failures it catches |
|---|---|
| `auth.spec.ts` | Password login broken; the refresh cookie not reaching `/api/auth/refresh` through the same-origin path rewrite, which signs users out on reload; log out leaving a session; wrong password creating one. |
| `board.spec.ts` | Card creation not persisted; `board:*` room fanout missing a second member; workspace-list fanout not reaching a *different* board; stale hydration after reload. |
| `guest-access.spec.ts` | A cross-organisation guest seeing an uninvited board (checked by the loaded board heading, not the canvas); revocation not ejecting a live guest; a cached route or sidebar entry reopening a revoked board. |
| `card-move.spec.ts` | List and board moves diverging between Kanban, table and Portfolio; duplicated or misplaced activity after a board transfer. |
| `drag-and-drop.spec.ts` | Real pointer drags reordering within a list and across lists at a specific index: the CDK index, the anchors sent to `/cards/:id/move`, `card:moved` reaching another viewer, and positions persisting after reload. |
| `lane-insert.spec.ts` | The hover strip between two lane items not offering "Add separator here"; the separator being appended to the lane instead of created with an `afterItem` anchor; the new separator not taking the board accent colour, or opening a title editor instead of being added ready-made; the inserted position not reaching another viewer or not surviving a reload; in My Cards, a card inserted between two cross-board cards that share a per-board position sorting after every tied card instead of between them, or the rebalance that makes room reordering the rest of the merged lane. Retains screenshots of the open strip and the My Cards lane. |
| `shared-fields.spec.ts` | Workspace custom-field renames not propagating; values lost on board transfer; custom-field filters not matching. |
| `comment-reply.spec.ts` | Replying to a comment leaving the caret inside the quoted blockquote, so the typed reply lands in the quote instead of below it; the sent reply not keeping the quote separate from the reply text. Retains a screenshot of the composer. |
| `card-links.spec.ts` | Card↔card and card↔note links. A link not appearing under "Linked items" on the linking card without reopening it (its `/detail` refresh discarded by the save's own `card:updated` echo); the linked card or note not listing the linker live for a viewer who already has it open (`card:links:changed` / `note:links:changed` through the outbox); a rename of a card or note not reaching linked items, note backlinks and description link chips live; a `card:updated` rename echo rewriting a just-opened description editor and corrupting the text being typed; linked items pointing at a non-route (`/c/<key>`); linked items, note backlinks and link chips doing a full page reload instead of in-app navigation; unlinking not clearing either end live. Retains screenshots of the viewer's backlink, the linking card and renamed note backlinks. |
| `mentions.spec.ts` | Mention picker, notification creation, unread and read state persisting, and notification deep links. |
| `onboarding.spec.ts` | Both signup paths; workspace-scoped lists and fields missing on a later board; a standalone board wrongly setting `hasWorkspace`. |
| `reconnect.spec.ts` | A client that missed events while its socket was down not resyncing after rejoin. `SocketLink` proves the socket was actually cut. |
| `attachments.spec.ts` | The four-surface attachment rule (description, comments, attachment list, activity): previewable types open the lightbox, other types download under their original name; inline uploads replacing earlier inserts; Escape in the lightbox closing the card. |
| `lightbox-touch.spec.ts` | On a phone-sized touch device: a two-finger pinch that lands on the lightbox backdrop rather than the fitted image not zooming (the app's viewport meta disables browser zoom); lifting the fingers closing the lightbox; double-tap not toggling zoom. Uses real CDP multi-touch. |
| `public-api.spec.ts` | Public API key and webhook creation in settings; public API writes (a separate process) not reaching open web clients through the outbox, worker and Redis adapter; webhook delivery, HMAC signature and envelope. |
| `cli-oauth.spec.ts` | CLI OAuth device sign-in, consent approval and denial, owner-only refresh-token storage, live CLI and stdio-bridge writes, token rotation and concurrent refresh, connection replacement and revocation, read-only credential enforcement, and logout removing the grant from Settings. |
| `mcp-protocol.spec.ts` | The same matrix over HTTP and the bundled `kanera mcp` stdio server, in both the 2026-07-28 era (pinned `server/discover` negotiation) and the 2025 `initialize` era, using the official client SDK: discovery and capabilities, `tools/list` with draft-07 schemas, a read (`boards.get`), a write (`cards.create`) arriving live on an open board for every cell, resource templates and `resources/read`, `prompts/list` and `prompts/get`, cancellation rejecting locally and leaving the session usable, and the three error shapes (bad arguments as an `isError` result, unknown tool as `-32602`, domain failure as an `isError` problem document). `mcp-protocol-matrix.json` retains per-cell protocol evidence. |
| `live-card-edits.spec.ts` | Another user's rename, description, list move, completion and unassignment not reaching, without a reload: the viewer's open card detail (board and Global Work hosts), the Kanban tile, the board table, board Work done, My Cards (board and table), Team Cards (board and Work done), and Portfolio table. |

| `mcp-events.spec.ts` | API key creation in settings; MCP event catalog and capability discovery, including list filters and invalid-list rejection; actor payload schemas; protocol-version validation and removed-method errors; notification acceptance; tool-created cards appearing live; insecure callback rejection; and discovery denied after credential revocation. `apps/api/src/modules/integrations/mcp-events.itest.ts` substitutes only outbound callback I/O because production rejects local receivers; it verifies signed list-scoped arrivals, departures, reorder exclusion, event-time update matching, unrelated-list exclusion, subscription identity/refresh/unsubscribe, and foreign-list rejection. |
| `mcp-checklists.spec.ts` | Agent checklist plans through MCP with the card open in the browser: one `checklists.create` call building items, a sub-checklist and its leaves with ids returned at every level; the tree arriving in order through realtime without a reload (including the item drawer); a retry with the same idempotency key replaying instead of duplicating; invalid batches (leaf-only fields on sub-checklist items, a non-member assignee) naming the exact field path and writing nothing; `checklists.add_items` keeping request order at an anchor; `checklists.update_items` applying different changes to chosen items (by id and by scoped text); ambiguous text targets rejected with candidates and no write; the audit rows (checklist created, assignee/due date set, item created, item updated, sub-checklist completed); and the bundled `kanera` CLI passing a nested plan and per-item updates as single JSON-array flags, arriving live in the open card. `mcp-checklists-evidence.json` and screenshots retain each step. |
| `email-unsubscribe.spec.ts` | The lifecycle-email unsubscribe link failing without a session; the RFC 8058 one-click `List-Unsubscribe` target not accepting a provider's form post through the `/api` proxy path; opening the link (as an inbox link scanner would) unsubscribing before the click; a forged link being accepted; unsubscribing also turning off card-notification email; and the onboarding-tips toggle appearing on self-hosted deployments, which never send these emails. The time-driven hosted sweep itself (which moment fires, for whom, once) cannot be reached without weeks of history, so `apps/api/src/lib/lifecycle-emails.itest.ts` covers it with backdated rows; its header lists the failure modes. A screenshot of the unsubscribed state is retained. |
| `board-overview.spec.ts` | Neutral active, overdue, unassigned and inactive counts without health verdicts; Portfolio metrics without Work risk; absence of health settings; inactivity-window persistence; overdue, unassigned and inactive drill-downs excluding completed cards; clearing filters; and the overview at a 390px mobile width. |

`runtimeGuard` also fails any spec on an uncaught page error, a `console.error`, or an HTTP 5xx.

## Retired isolated tests

Isolated (Vitest / node:test) cases removed because an E2E spec already fails on the same defect. Each
row names the failure the case caught and the spec that now catches it; the run that was executed
before deletion is recorded at the end of this section.

| Retired case | Failure | Covering E2E spec |
|---|---|---|
| `card-detail.component.spec` "downloads attachments with the stored file name" | download uses the storage key instead of the original filename | `attachments.spec.ts` (`expectDownload` → `suggestedFilename`) |
| `card-detail.component.spec` "downloads non-previewable attachments in comments…" / "keeps non-previewable activity attachments as download links" | a docx in a comment or activity row opens the lightbox instead of downloading | `attachments.spec.ts` |
| `card-detail.component.spec` "opens attachment-added activity files in the media lightbox" / "opens PDFs from the attachment list…" / "opens PDFs linked in the card description…" | activity image, list PDF or description PDF fails to open the lightbox | `attachments.spec.ts` (all four surfaces) |
| `board-state.spec` "re-emits board:join after reconnect" | no `board:join` after a socket reconnect, so the board misses events | `reconnect.spec.ts` |
| `board.page.spec` "shows card counts…", "shows zero active cards…", "keeps raw counts available with a legacy…", "shows only incomplete cards with no activity for 14 days" | overview tiles / drill-downs wrong; inactive includes completed | `board-overview.spec.ts` |
| `global-work.page.spec` "rolls up raw card counts…", "includes every board in raw metric rollups…", "keeps overdue metrics despite a legacy…" | Portfolio shows a risk verdict or drops legacy-health boards | `board-overview.spec.ts` |
| `global-work.state.spec` "applies known realtime mutations immediately…" | `assignees:set` not reflected in My Cards without a reload | `live-card-edits.spec.ts` |
| `global-card-detail-host.component.spec` "feeds card detail from the live route-scoped card state" | Global Work card detail not fed from live state | `live-card-edits.spec.ts` |
| `image-lightbox.component.spec` "pinches on the backdrop…" / "double-taps the image…" | backdrop pinch closes or ignores; double-tap does not toggle zoom | `lightbox-touch.spec.ts` |
| `login.page.spec` "signs in and stores the returned session" / "shows invalid credentials…"; `public-auth.client.spec` (whole) | session not stored; no wrong-password error; auth requests missing `credentials: include` | `auth.spec.ts` |
| `onboarding.page.spec` "creates a standalone board from the first-run path without changing hasWorkspace" | standalone first run flips `hasWorkspace` | `onboarding.spec.ts` |
| `workspace-settings.page.spec` "shows timing settings without board health configuration" | board-health settings reappear | `board-overview.spec.ts` |
| `description-editor.component.spec` "uploads files chosen from the file picker" / "includes uploaded attachment ids when saving" | file-picker upload not inserted; attachment ids not saved | `attachments.spec.ts` |
| `apps/mcp http.test.ts` "completes protocol initialization…" / "negotiates current Claude and generic MCP protocol revisions" | HTTP MCP initialise / version negotiation broken | `mcp-protocol.spec.ts` |

Also removed without an E2E prerequisite: `board.page.spec` member added/removed cases (duplicated
`board-state.spec`), plumbing-only cases (signal set/clear, fallback titles, mock-called-with-path,
static copy, UA shortcut hint, control-height classes), `realtime/metrics.test.ts` (asserted a stub
logger received its own arguments) and `lib/overdue-notifications.test.ts` (tested a one-line
pass-through; its one uncovered assertion moved into `lib/due-date.test.ts`).

E2E run executed before these deletions: `pnpm test:e2e`, 27/27 passed, artifacts under
`e2e/artifacts/20261006T231129Z-1794008/` (trace, screenshots, service logs and `REPRODUCE.txt`).

