# E2E coverage map

This file exists to satisfy the testing policy in `CLAUDE.md`: an isolated test is removed only after the failure it catches is shown to be covered by a passing E2E run, and after checking it adds no distinct signal. Update it when adding a spec or retiring an isolated test.

## What each spec catches

| Spec | Failures it catches |
|---|---|
| `auth.spec.ts` | Password login broken; the refresh cookie not reaching `/api/auth/refresh` through the same-origin path rewrite, which signs users out on reload; log out leaving a session; wrong password creating one. |
| `board.spec.ts` | Card creation not persisted; `board:*` room fanout missing a second member; workspace-list fanout not reaching a *different* board; stale hydration after reload. |
| `guest-access.spec.ts` | A cross-organisation guest seeing an uninvited board (checked by the loaded board heading, not the canvas); revocation not ejecting a live guest; a cached route or sidebar entry reopening a revoked board. |
| `card-move.spec.ts` | List and board moves diverging between Kanban, table and Portfolio; duplicated or misplaced activity after a board transfer. |
| `drag-and-drop.spec.ts` | Real pointer drags reordering within a list and across lists at a specific index: the CDK index, the anchors sent to `/cards/:id/move`, `card:moved` reaching another viewer, and positions persisting after reload. |
| `shared-fields.spec.ts` | Workspace custom-field renames not propagating; values lost on board transfer; custom-field filters not matching. |
| `mentions.spec.ts` | Mention picker, notification creation, unread and read state persisting, and notification deep links. |
| `onboarding.spec.ts` | Both signup paths; workspace-scoped lists and fields missing on a later board; a standalone board wrongly setting `hasWorkspace`. |
| `reconnect.spec.ts` | A client that missed events while its socket was down not resyncing after rejoin. `SocketLink` proves the socket was actually cut. |
| `attachments.spec.ts` | The four-surface attachment rule (description, comments, attachment list, activity): previewable types open the lightbox, other types download under their original name; inline uploads replacing earlier inserts; Escape in the lightbox closing the card. |
| `lightbox-touch.spec.ts` | On a phone-sized touch device: a two-finger pinch that lands on the lightbox backdrop rather than the fitted image not zooming (the app's viewport meta disables browser zoom); lifting the fingers closing the lightbox; double-tap not toggling zoom. Uses real CDP multi-touch. |
| `public-api.spec.ts` | Public API key and webhook creation in settings; public API writes (a separate process) not reaching open web clients through the outbox, worker and Redis adapter; webhook delivery, HMAC signature and envelope. |
| `live-card-edits.spec.ts` | Another user's rename, description, list move, completion and unassignment not reaching, without a reload: the viewer's open card detail (board and Global Work hosts), the Kanban tile, the board table, board Work done, My Cards (board and table), Team Cards (board and Work done), and Portfolio table. |

`runtimeGuard` also fails any spec on an uncaught page error, a `console.error`, or an HTTP 5xx.

## Defects found by the suite (2026-09-24)

Each was reproduced by the spec before the fix, and the spec was confirmed to pass after it.

1. **Escape in the attachment lightbox also closed the card detail.** `CardDetailComponent.onDocumentKeydown` ignored that the CDK dialog had already consumed the key. It now returns when `event.defaultPrevented`. Caught by `attachments.spec.ts`.
2. **Uploading a file right after an image replaced the image** in descriptions and comments, including multi-file drops. `setImage` left a NodeSelection on the image. The uploader now inserts a trailing paragraph. Caught by `attachments.spec.ts` (`insertIntoEditor` re-checks earlier inserts).
3. **Card webhooks omitted the documented top-level `cardId`.** `cardIdFromPayload` only read `payload.cardId`, but `card:*` events carry `payload.card`. Caught by `public-api.spec.ts`.
4. **Harness: E2E ran against `ioredis-mock`.** `NODE_ENV=test` gave every service a private in-memory Valkey, so cross-process realtime could not work. This was invisible because every other test also runs with `NODE_ENV=test`. The runner now uses `NODE_ENV=development`.
5. **Harness: false passes.** A "guest can open board" check passed on a board the guest had been removed from, because `k-board` renders before the access check. Tests also depended on each other's seed mutations. Fixed with `expectBoardLoaded` and per-test boards.
6. **The board's Work done view missed other users' moves and new cards until reload.** `BoardSocketBridge` refreshed it only on `card:updated` (completions), not on `card:moved` or `card:created`. Global Work's Work done was unaffected. Caught by `live-card-edits.spec.ts`.

## Isolated tests verified redundant (safe to delete)

Each case below was checked by mutation on 2026-09-24. The behaviour the unit test guards was broken in the app, and the named E2E test failed on that exact behaviour. The unit test asserts nothing beyond it.

| Isolated test case | Mutation | E2E failure that caught it |
|---|---|---|
| `apps/web/.../auth/login.page.spec.ts`: "shows invalid credentials for rejected logins" | Rejected-login message changed | `auth.spec.ts`, wrong password: `.error-banner` lacks "Invalid credentials" (the same test also asserts no session and staying on `/login`) |
| `apps/web/.../board/board-state.spec.ts`: "notifies after each successful board join" | `onJoined` fired only for the first join, not after reconnect | `reconnect.spec.ts`: the viewer never converged on the missed rename |
| `apps/web/.../global-work/global-card-detail-host.component.spec.ts`: "feeds card detail from the live route-scoped card state" | Detail fed from the static input instead of the route-scoped `BoardState` | `live-card-edits.spec.ts`, Global Work: the open My Cards detail kept the old title |

Checked and kept, because each has a distinct signal E2E cannot give:

- `login.page.spec.ts`, "signs in and stores the returned session": asserts `credentials: "include"`, which only matters cross-origin (the dev build). E2E runs same-origin like production.
- `board-state.spec.ts`, "re-emits board:join after reconnect": also asserts `board:leave` on detach.
- `onboarding.page.spec.ts`, "creates a standalone board from the first-run path…": asserts the exact template payload.

## Isolated tests that overlap E2E coverage

None of these has been retired. "Distinct signal" records what the isolated test catches that E2E does not; a test with distinct signal stays even when its happy path is covered.

| Isolated test | Overlapping spec | Distinct signal (keep) or status |
|---|---|---|
| `apps/web/.../auth/login.page.spec.ts` | `auth.spec.ts` | Client-side validation messages without a request (empty password). **Keep** until E2E asserts those. |
| `apps/web/.../core/auth/auth.guard.spec.ts`, `auth.service.spec.ts` | `auth.spec.ts` | Hydration retry while the API restarts, logout-versus-refresh races, safe return URLs, and invitation tokens through the guard. **Keep.** |
| `apps/web/.../core/realtime/socket.service.spec.ts` | `reconnect.spec.ts` | Room reference counting, offline signalling, visibility-resume and stalled-reconnect recovery, and server eviction. E2E covers only a clean cut and restore. **Keep.** |
| `apps/web/.../board/board-state.spec.ts` | `board.spec.ts`, `drag-and-drop.spec.ts`, `reconnect.spec.ts` | Rebalance event handling, cover metadata across full-card updates, and live role changes. "Re-emits board:join after reconnect" overlaps `reconnect.spec.ts`; that one case is a retirement candidate. **Keep the file.** |
| `apps/web/.../board/description-editor-uploader.service.spec.ts` | `attachments.spec.ts` | Quota and plan-size error messages, the note upload endpoint, and scratchpad rollback. **Keep.** |
| `apps/web/.../shared/attachment-preview.spec.ts` | `attachments.spec.ts` | Full MIME and extension table (video, audio, markdown). E2E samples image, PDF and DOCX only. **Keep.** |
| `apps/web/.../board/image-lightbox.component.spec.ts` | `attachments.spec.ts` | Gallery cycling, wheel and pinch zoom, panning, and video, audio and PDF rendering. **Keep.** |
| `apps/web/.../board/card-drag-scroll.spec.ts`, `card-drag-coordinator.service.spec.ts` | `drag-and-drop.spec.ts` | Edge auto-scroll speed by pointer type and hit-element style restoration. E2E drags with a mouse inside the viewport. **Keep.** |
| `apps/web/.../notifications/notifications-panel.component.spec.ts` | `mentions.spec.ts` | Focus trapping, offline and error states, organisation context, and refresh with a positive unread count. "Opens and loads the first page" is a retirement candidate. |
| `apps/web/.../onboarding/onboarding.page.spec.ts` | `onboarding.spec.ts` | Candidate: evaluate per case. |
| `apps/api/src/realtime/outbox.itest.ts` | `public-api.spec.ts` | Batched drains, retry without rebroadcast after a webhook-enqueue failure, and the direct user/client outbox. Note that it runs with `ioredis-mock`, so it cannot catch cross-process delivery; only `public-api.spec.ts` does. **Keep.** |
| `apps/api/src/lib/webhooks.itest.ts`, `modules/integrations/webhook-endpoint.routes.itest.ts` | `public-api.spec.ts` | Hosted plan gating, no double delivery from concurrent sweeps, chat snapshots, never following redirects, and endpoint scoping by credential. **Keep.** |
| `apps/api/src/auth/routes.itest.ts` | `auth.spec.ts` | Signup and forgot-password rate limiting, MFA enrollment and login, refresh-token rotation and reuse detection. E2E raises the login limit. **Keep.** |

## Known gaps

- Email flows (invites, password reset, email verification): these need a mail catcher such as Mailpit in `docker-compose.e2e.yml`.
- Roles: observers and read-only guests blocked in the UI and the API.
- Automations and their side effects.
- Calendar views (board and Global Work), and field, label, assignee and due-date edits reaching other viewers live.
- Video, audio and Markdown attachments; the lightbox's previous and next navigation.
