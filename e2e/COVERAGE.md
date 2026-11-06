# E2E coverage map

Use this index to find a spec. Keep each entry to one short summary; detailed scenarios and
failure modes belong in test names and nearby comments. Update the relevant row only when coverage
changes. Do not add run history or pass/fail results.

See [README.md](README.md) for fixtures, execution, artifacts, and the limits of browser, touch,
offline/PWA, billing, and screenshot coverage. API-only assertions remain service-level coverage;
concurrent request bursts do not replace deterministic database race tests.

| Spec | Coverage |
|---|---|
| [shutdown](shutdown.spec.ts) | All four services exiting after SIGTERM with real Valkey, Valkey connection loss, API presence cleanup, and worker recovery after an idle PostgreSQL session is terminated. |
| [account-settings-pages](account-settings-pages.spec.ts) | Security and Preferences navigation, direct reloads, Profile section boundaries, and phone layout. |
| [agent-files](agent-files.spec.ts) | Agent scratchpad capture and uploaded files reaching an open browser through realtime. |
| [angular-editor-races](angular-editor-races.spec.ts) | Pending or rejected saves preserving newer drafts, selections, uploads, note locks, and editor usability across navigation and backgrounding. |
| [angular-session-races](angular-session-races.spec.ts) | Logout isolating queues, late identity responses, offline identity, and appearance subscriptions between accounts. |
| [angular-settings-races](angular-settings-races.spec.ts) | Ordered automation saves, scratchpad reconnect convergence, caret preservation, and keyboard submission. |
| [angular-state-races](angular-state-races.spec.ts) | Stale navigation responses, foreground/realtime reconciliation, Home loading, retained pagination, composed selections, and newer remote field values. |
| [assignment-parity](assignment-parity.spec.ts) | Single and bulk labels/assignees preserving automation results, event order, idempotency, and live board/inbox delivery. |
| [attachment-reactions](attachment-reactions.spec.ts) | Attachment reactions, quoting, uploader notifications, removal, and persistence reaching other viewers live. |
| [attachments](attachments.spec.ts) | Preview/download behavior across four surfaces, decoded media and original file bytes, cover deletion/undo, and live activity. |
| [auth](auth.spec.ts) | Password login, invalid credentials, refresh-cookie proxying, reload persistence, and logout. |
| [billing-realtime](billing-realtime.spec.ts) | Committed plan conversions updating live navigation through separate processes; rolled-back conversions emitting nothing. |
| [board](board.spec.ts) | Card persistence, board and workspace-list fanout, reload convergence, and late cards beyond the lane render cap. |
| [board-overview](board-overview.spec.ts) | Exact counts, inactivity preferences, completed-card exclusion, filter drill-downs and phone access. |
| [card-dependencies](card-dependencies.spec.ts) | Dependency editing, blocked completion, cross-board fanout, archive/restore, notifications, ready automations, and relationship search. |
| [card-detail-layout](card-detail-layout.spec.ts) | Reachable drawer/editor controls, overflow, title/close separation and picker placement in desktop panel/modal and phone layouts. |
| [card-detail-performance](card-detail-performance.spec.ts) | Large-card request/cache budgets, checklist drag indices and responsiveness, 304 revisions, and first-open outbox reconciliation. |
| [card-follow](card-follow.spec.ts) | Reminder creation, scheduling, firing, clearing, watching, filters, and live drawer, tile, Home, and inbox updates. |
| [card-links](card-links.spec.ts) | Canonical clipboard links, two-way links and renames, SPA navigation, editor preservation, unlinking, and coalesced refreshes. |
| [card-move](card-move.spec.ts) | List/board moves converging across Kanban and table with correct transfer activity; rapid single/bulk list reversals remove live and persisted activity/inbox entries while forward moves stay separate. |
| [checklist-activity](checklist-activity.spec.ts) | Checklist activity coalescing and live row updates while delayed acknowledgements preserve the next draft. |
| [cli-oauth](cli-oauth.spec.ts) | Device consent, denial, token storage/rotation/revocation, read-only enforcement, catalogue reuse, logout, and live CLI/stdio writes. |
| [client-board-sync](client-board-sync.spec.ts) | Client comments/files syncing live while internal fields and discussion remain private and later updates remain ordered. |
| [comment-reply](comment-reply.spec.ts) | Caret and typed replies staying outside quotes in fresh, open, and existing-draft composers. |
| [correctness-scan](correctness-scan.spec.ts) | Concurrent refresh/checklist writes, transfer access cleanup, post-automation responses and comment context, and deleted-list fanout. |
| [dependency-automations](dependency-automations.spec.ts) | Cross-board MCP dependency triggers, retry suppression, reopen/restore/unlink transitions, and worker-chained mirror handoffs. |
| [dependency-map](dependency-map.spec.ts) | Cross-board graph updates, dependency editing/undo, readiness, critical paths, date-axis layout, filters, and touch/phone geometry. |
| [drag-and-drop](drag-and-drop.spec.ts) | Pointer-driven lane scrolling and precise same-list/cross-list ordering reaching another viewer and surviving reload. |
| [editor-formatting-shortcuts](editor-formatting-shortcuts.spec.ts) | Selection, inline code, link shortcut/focus, clear formatting, and formatted content surviving save/reload. |
| [editor-image-drag](editor-image-drag.spec.ts) | Image reordering without duplicate uploads, undo/redo, and saved order across descriptions, comments, notes, and scratchpad. |
| [editor-recovery-audit](editor-recovery-audit.spec.ts) | Notes, descriptions, and new/edited comments retaining drafts across late saves, close/reopen, reconnect, failed reads, and rejected writes. |
| [editor-draft-ownership](editor-draft-ownership.spec.ts) | Saving in another tab preserves description and comment drafts; delayed checklist-description saves preserve a reopened drawer's newer work. |
| [email-unsubscribe](email-unsubscribe.spec.ts) | Signed unsubscribe links, scanner-safe confirmation, one-click form posts, forged tokens, and independent notification preferences. |
| [getting-started](getting-started.spec.ts) | Onboarding checklist guidance, automatic completion, hiding, account-menu access, and removal. |
| [global-work-foreground](global-work-foreground.spec.ts) | My Cards/Team Cards avoiding redundant brief-return reloads while recovering hidden updates, long absences, and socket outages. |
| [guest-access](guest-access.spec.ts) | Cross-organisation board isolation, live revocation, and denied cached routes/sidebar entries. |
| [i18n](i18n.spec.ts) | Persisted account/chat languages, translated dates/errors/import warnings, request language headers, and localized PWA metadata. |
| [in-progress-alert](in-progress-alert.spec.ts) | Age alerts clearing live, imported clocks, progress filters, and searchable/persisted working-hours time zones. |
| [in-progress-lists](in-progress-lists.spec.ts) | List flagging and moves updating clocks live; organisation/board switches stopping, preserving, and restoring tracking across views. |
| [keyboard-shortcuts](keyboard-shortcuts.spec.ts) | Dialog focus containment, title focus, input-safe navigation sequences, and drawer-scoped shortcuts. |
| [lane-insert](lane-insert.spec.ts) | Card/separator insertion anchors, precise live ordering, reload persistence, and tied positions across boards in My Cards. |
| [lightbox-touch](lightbox-touch.spec.ts) | Real multi-touch pinch and double-tap zoom without backdrop dismissal. |
| [live-card-edits](live-card-edits.spec.ts) | Another member’s edits converging across mounted detail, Kanban, table, Work done, My Cards, and Team Cards. |
| [mcp-checklists](mcp-checklists.spec.ts) | Nested checklist plans and updates through MCP/CLI: realtime ordering, idempotency, atomic rejection, ambiguous targets, and audit activity. |
| [mcp-events](mcp-events.spec.ts) | Event discovery/schema/filter validation, callback security, live tool writes, and revoked-credential rejection. |
| [mcp-protocol](mcp-protocol.spec.ts) | HTTP/stdio protocol eras, usable Draft 7 schemas, catalog-wide safety labels, replay guidance and OAuth scopes, live writes, resources/prompts, cancellation recovery, and distinct error shapes. |
| [mermaid-diagrams](mermaid-diagrams.spec.ts) | Mermaid fences draw as SVG in descriptions, notes and Markdown attachments, update when switching themes and returning to a cached theme, retain readable sizing and scroll within phone layouts, stay code in comments, and keep their source when they fail to parse. |
| [mentions](mentions.spec.ts) | Mention selection, live notifications, persisted read state, deep links, and coalesced badge updates across sessions. |
| [mfa-invite](mfa-invite.spec.ts) | New/existing invitees enrolling before session access, signed-in invitation handling, and navigation after enrollment. |
| [mobile-navigation](mobile-navigation.spec.ts) | Notification taps/swipes, navigation open/dismiss behavior, reduced-motion usability, hidden personal tools and desktop sidebar access. |
| [notes-save-recovery](notes-save-recovery.spec.ts) | Recovered drafts retaining their baseline and newer text across remote edits, delayed responses, locks, and navigation. |
| [notes-toggle](notes-toggle.spec.ts) | Workspace/standalone Notes switches updating navigation, API access, search, and linked items live while retaining stored notes. |
| [offline-navigation](offline-navigation.spec.ts) | Offline navigation and shortcut restrictions, retained local actions, phone controls, and recovery on reconnect. |
| [offline-team-overview](offline-team-overview.spec.ts) | Cold reload preserving overview activity, unowned work, focused-person queues, read-only behavior, and reconnect freshness. |
| [offline-up-next](offline-up-next.spec.ts) | Persisted personal queues, offline reloads, disabled edits across hosts, and reconnect convergence. |
| [offline-notes](offline-notes.spec.ts) | Workspace note selection and cached body after an offline reload, read-only controls, and reconnect convergence. |
| [offline-views](offline-views.spec.ts) | Offline Timeline, Dependencies, Work done, and reports retaining data, disabling writes, isolating history queries, and recovering on reconnect. |
| [onboarding](onboarding.spec.ts) | Workspace and standalone signup, shared configuration, template flags/colours, and correct onboarding completion state. |
| [performance-async](performance-async.spec.ts) | Mirror creation/title/comment fanout, no historical backfill, pause enforcement, cursor-reset reconciliation, and persistence. |
| [performance-backend](performance-backend.spec.ts) | Permission-safe linked-item batching/revocation and child-activity timestamps. |
| [performance-frontend](performance-frontend.spec.ts) | Complete description diffs, coalesced bounded deep-table refreshes retaining exact IDs, and offline note persistence without unrelated rewrites. |
| [planning-features](planning-features.spec.ts) | Organisation/workspace feature switches changing live views, deep links, API access, and retained planning data. |
| [promise-toasts](promise-toasts.spec.ts) | Bulk actions, imports, and exports settling one toast correctly while preserving saved state, dismissal, and supported restore behavior. |
| [public-api](public-api.spec.ts) | Public API writes reaching open boards through the worker/outbox and producing correctly signed webhook envelopes. |
| [realtime-compression](realtime-compression.spec.ts) | Configured websocket negotiation and ordered, intact small/large updates through the real outbox/Valkey path. |
| [reconnect](reconnect.spec.ts) | Proven socket outages recovering card and agent-run snapshots; brief foreground returns avoiding redundant requests. |
| [scratchpad-save-recovery](scratchpad-save-recovery.spec.ts) | Scratchpad foreground/reconnect preservation, idle-session autosave isolation, and note draft ownership across browser tabs. |
| [scratchpad-idle-recovery](scratchpad-idle-recovery.spec.ts) | Single-tab editor recovery after failed background reads, subsequent overwrite risk, and late acknowledgements preserving closed-dock drafts. |
| [rich-card-create](rich-card-create.spec.ts) | SDK/MCP/CLI single/bulk creation preserving typed fields and external identities, idempotency, atomic validation, and live rendering. |
| [shared-fields](shared-fields.spec.ts) | Shared field renames, transfer/filter persistence, no-op saves, and fractional values surviving creation/reload. |
| [storage-cleanup](storage-cleanup.spec.ts) | Storage filtering, selection/deletion, live attachment removal for another viewer, and phone layout. |
| [team-overview](team-overview.spec.ts) | Correct activity/assignment attribution, counts, drill-downs, guest visibility, focused-person queues, dragging assigned/in-progress overview cards into personal and teammate queues, ranking, and live cross-session updates. |
| [time-tracking](time-tracking.spec.ts) | Working-hour totals, overnight/weekend pauses and resumption, banked stints, short-total suppression, table aggregates, and Work done. |
| [timeline](timeline.spec.ts) | Date/dependency editing, cross-board updates, filters, conflicts/critical paths, observer/touch access, and bounded rendering for large boards. |
| [timeline-notifications](timeline-notifications.spec.ts) | Progress-limit settings syncing live and worker-generated scheduling conflicts notifying the right person once. |
| [unchanged-edits](unchanged-edits.spec.ts) | Unchanged single/bulk card and checklist edits preserving activity counts and timestamps. |
| [user-profile](user-profile.spec.ts) | Popover lifecycle/focus, exact work counts and completion grid, assignee actions, person deep links, and guest privacy/revocation. |
| [work-table-folds](work-table-folds.spec.ts) | Saved-view folds and expanded rows surviving reload and realtime reconciliation without stale data. |
| [workspace-board-order](workspace-board-order.spec.ts) | Grouped board ordering matching navigation through drag, realtime changes, and reload without phone overflow. |

## Retained isolated coverage

These suites cover cases browser scheduling or the E2E environment cannot reliably exercise.
Check their failure-mode comments before removing or replacing tests.

| Area | Suite and boundary |
|---|---|
| API-only history and runs | [History pagination](../apps/api/src/modules/work/history-pagination.itest.ts) checks request-generated events, cursors, move paths and summaries. [Agent runs](../apps/api/src/modules/agent-runs/routes.itest.ts) checks concurrent finish/heartbeat requests and deterministic rejection after completion; concurrency is smoke coverage, not a forced interleaving. |
| Card detail | [Persistence](../apps/web/src/app/features/board/card-detail-persistence.service.spec.ts), [requests](../apps/web/src/app/features/board/card-detail-request.spec.ts), and [board state](../apps/web/src/app/features/board/board-state.spec.ts): lifecycle, cancellation, revision and ordering races. [API](../apps/api/src/modules/cards/routes.itest.ts): database isolation, cascades and rollback. |
| Dependencies | [Relations](../apps/api/src/modules/cards/relations.itest.ts): concurrent blocker transitions, exactly-once actions, access and notification rules. [Graph](../apps/api/src/modules/cards/dependency-graph.itest.ts): visibility boundaries. |
| Working time | [In-progress integration](../apps/api/src/modules/lists/in-progress.itest.ts): aged/disabled intervals, write-path parity, flag-change races, imports, and once-per-stint triggers. |
| Layout and input | Web specs beside the dependency map, timeline, editor, keyboard, and time-zone helpers cover deterministic geometry, date arithmetic and modifier edge cases. |
| Notifications | API schedule-notification, daily-digest, assignee-email and attachment-reaction suites cover recurrence, recipients, privacy, email and delivery idempotency. |
| MCP callbacks | [Event integration](../apps/api/src/modules/integrations/mcp-events.itest.ts): signed delivery, filtering, identity, replay deduplication and privacy; E2E callback protections reject local receivers. |
| Lifecycle email | [Lifecycle integration](../apps/api/src/lib/lifecycle-emails.itest.ts): hosted eligibility, timing and deduplication requiring backdated history. |
| Billing | [Reliability](../apps/api/src/modules/billing/reliability.itest.ts): Stripe response ordering, duplicate Checkout and transaction failures. |
| Storage | [Storage integration](../apps/api/src/modules/clients/storage.itest.ts): usage, privacy/access, description cleanup and warning-email rearming. |
| Workspace deletion | [Deletion integration](../apps/api/src/lib/workspace-delete.itest.ts): forced outbox deadlock recovery, atomic notification deletion, bounded retries, and unrelated-error propagation. |
| Toasts | [Toast service](../apps/web/src/app/shared/toast.service.spec.ts): exact timer boundaries, concurrent settlement, dismissal/teardown and result propagation. |

## Additional checks

- [Hosted analytics](analytics/attribution.browser.ts), via `pnpm test:analytics`: consent, visitor identity and first-touch signup attribution in a separate production-configured build.
- [Production bundles](../benchmarks/web/bundle-loading.config.cjs), via `pnpm test:web:bundles`: cache headers, deferred views/icons, service-worker registration and cold offline reload against the seeded local API and Nginx.

- `security-media-export.spec.ts`: guest board exports exclude unrelated workspace members; media renewal enforces revoked board access and resolves cross-organisation guest storage, and preserves personal note/scratchpad privacy.
