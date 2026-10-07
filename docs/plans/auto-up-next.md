# Automatic Up Next placement

Status: proposal, 2026-10-07. Nothing here is implemented yet.

## Problem

"Up next" (`card_priority`) is a hand-curated per-person queue. Every entry is added and ordered by a
manager or by the assignee. In a workspace of any size that is a chore nobody keeps up with, so the
queue is either empty or stale, and the feature loses its meaning.

The ask: when a card is assigned, the system should place it in the assignee's queue by itself, using
the signals the workspace already has (board, list, due date, card order), per workspace or standalone
board, without taking the queue away from the people who curate it.

## What exists today (constraints the design must respect)

- `card_priority` is keyed by `(target_user_id, card_id)`, holds a `numeric` position, and is
  deliberately not workspace-keyed: one person's queue spans workspaces and guest boards. The live
  set is "assigned to the target, not completed, not archived", filtered at read time. Cap is 50 live
  entries per person. Writes serialise on a per-target advisory lock
  (`apps/api/src/modules/card-priorities/routes.ts`).
- Rank is server-owned and pushed as a full snapshot (`cardPriority:snapshot`) to the target, with a
  content-free `cardPriority:invalidated` ping to managers. Any write that changes the live set must
  end with `emitCardPriorityInvalidated` / `invalidateQueuesForCards` after commit.
- Assignees are written in five places, all inside a transaction:
  card create (`cards/routes.ts` ~832), bulk assignees (~1207), `PUT /cards/:id/assignees` (~3670),
  the `add_assignees` automation action (`lib/automations.ts` ~608), and duplicate card
  (`cards/duplicate-card.ts` ~688). The public API, MCP, and CLI all land on these routes.
- A standalone board is a hidden `workspace` row with `kind = "board"`, so "per workspace or standalone
  board" is one workspace column, surfaced on both settings pages the way `notesEnabled` is.
- Lists are workspace-scoped and ordered by `lists.position`; boards by `boards.position`; cards by
  `cards.position` within a list. Due dates are `due_date_local_date` + slot + timezone.

## Design

### 1. One workspace setting

`workspace.up_next_mode`, text with a `CHECK`, tuple `UP_NEXT_MODES = ["manual", "insert", "arrange"]`:

| Mode | Behaviour |
| --- | --- |
| `manual` | Today's behaviour. Default for existing and new workspaces, so nothing changes until an admin opts in. |
| `insert` | On assignment, the card is inserted into the assignee's queue at the slot its score earns. Existing entries never move. |
| `arrange` | `insert`, plus: when a queued card's signals change (due date, list, board), the system re-sorts the entries *it* placed. Human-placed entries never move. |

One extra knob, `workspace.up_next_due_horizon_days` (int, default 7), used by the scoring below.

Exposed on the workspace settings page and the standalone board settings page next to the Notes
toggle, patched through the existing `PATCH /workspaces/:id` route and DTO.

### 2. Provenance on every entry

`card_priority.source`, text with a `CHECK`, tuple `CARD_PRIORITY_SOURCES = ["manual", "auto"]`,
default `manual` (the migration backfills nothing; every existing row is a human's choice).

Rules:

- A human add via the existing route writes `manual`.
- A human move of an `auto` entry flips it to `manual`. Dragging is a statement, and the system must
  never undo it.
- The system only ever inserts `auto` rows and only ever moves `auto` rows.
- `source` is returned on `WorkPriorityItem` so the UI can mark auto rows, and so the public API and
  MCP `priorities.list` expose it.

### 3. Scoring: tiers, then position signals

Deterministic and explainable. No weighted sum, because a weighted sum cannot be explained in a
tooltip and will be argued with. Compare lexicographically:

0. **Effective due date, per target.** The earlier of the card's own due date and the earliest
   due date among *open* checklist items on the card assigned to the target user. Checklist items are
   already first-class work for overdue notifications, Home due-soon and the daily digest, and the
   queue is per person, so the signal is per person too. Items assigned to someone else do not count.
   The reason string says which one won ("checklist item due tomorrow" vs "due tomorrow").
1. **Tier** (ascending), on the effective due date:
   - `0` overdue
   - `1` due within `up_next_due_horizon_days` (inclusive, in the card's own timezone)
   - `2` everything else (later due dates and undated cards together)
2. Within tiers 0 and 1: **due date** ascending, then slot (morning before afternoon before evening,
   dateless slot last).
3. Then **list stage**, later list first. Lists read left-to-right as stages, so a card in Review is
   closer to done than one in Backlog, and "finish what is started" is the right default. This is the
   one rule most likely to be disputed; it is documented in the settings copy.
4. Then **board order** within the workspace (`boards.position` ascending). The sidebar order is the
   manager's standing statement about what matters. Cards from different workspaces compare equal
   here and fall through.
5. Then **card order** within its list (`cards.position` ascending). The board's top-to-bottom order
   is already a manual priority signal; the queue should agree with it.
6. Tie-break: `card.updatedAt` descending (recently touched first, only among otherwise equal
   undated cards), then `assignedAt`, then `card.createdAt`, then id.

Signals deliberately **not** used:

- **Inactivity as a demotion.** "Nobody touched it" means either "abandoned" or "forgotten", and a
  queue that buries forgotten work defeats its purpose. It must never outrank a due date. Its only
  role is the tier-2 tie-break above, and even that is applied on a real signal change, never because
  time passed.
- **Comment, mention or activity volume.** Volume measures noise, not urgency: a forty-comment card
  is usually blocked, not important. It is gameable and would reorder queues on every "any update?".

Every placement records the winning rule as a short reason string (`"overdue"`,
`"due in 3 days"`, `"in Review"`, `"top of Board X"`) in the activity payload and on the item, so the
UI tooltip can say why the card sits where it sits.

### 4. Insert algorithm (both automatic modes)

`placeAutoPriority(tx, { cardId, targetUserId, actorId })`, in a new
`apps/api/src/lib/card-priority-auto.ts`, called from each of the five assignment sites after the
assignee insert, inside the same transaction, once per *newly added* assignee. Steps:

1. Return early unless the card's workspace mode is `insert` or `arrange`, the card is live, and the
   card is not already in the queue (any source).
2. Take the per-target advisory lock (reuse `lockQueueForWrite`, exported).
3. If the live queue already has 50 entries, do nothing and record a `noop` reason. Auto never evicts.
4. Load the live queue with each entry's signals, score the new card and every `auto` entry.
5. Walk the queue in order. Insert immediately before the first `auto` entry whose score is worse
   than the new card's. `manual` entries are skipped in the comparison but keep their positions, so
   they act as fixed points the system threads around. If no auto entry is worse, append at the end.
6. Interpolate with `between(prev, next)`, rebalance via `rebalanceCardPriorities` if needed, insert
   with `source = "auto"`, `createdById = actorId` (the assigner; the FK needs a real user).
7. Record activity through the same private-scoped helper the manual routes use (`boardId: null`,
   `priorityCardId`, `scope: "globalWork"`) with `payload.source = "auto"` and the reason.

After commit, the existing `invalidateQueuesForCards([cardId])` call already present at every
assignment site pings the new assignee, because they now hold the card. No new realtime event is
needed. The automation path must be checked to confirm `emitAutomationEffects` makes that same call for
`assigneesSet` effects.

### 5. Re-arrange (arrange mode only)

`rearrangeAutoPriorities(cardIds)` runs after commit from the due-date set/clear route, the checklist
item due-date set/clear, assign and complete routes (they change the effective due date), the list
move route, and the move-to-board route, for each target whose live queue holds one of the cards and whose
workspace is in `arrange` mode. Under the lock it:

1. Loads the live queue, scores every `auto` entry.
2. Collects the positions currently occupied by `auto` entries (the "auto slots").
3. Stable-sorts the auto entries by score and writes them back into the auto slots in that order.

Manual rows are untouched, which also means their rank numbers never change under the user's feet. A
move is a no-op when the order is already correct, so it produces no outbox rows or audit noise. Board
reordering is deliberately not a trigger in v1: it is rare, and the next card signal change catches up.

### 6. UI

- Workspace settings and standalone board settings: an "Up next" card with the mode select, the
  horizon input (shown for the two automatic modes), and one sentence per mode. Copy must not say
  "saves automatically"; the autosave chip is the contract.
- Queue rows (`priority-queue.component.ts`, used by Home, My Cards, Up Next panel, Team Cards lanes):
  an auto marker (`ti ti-sparkles`) with the reason as its tooltip. Dragging an auto row sends the
  existing move and the server flips it to manual, so the marker disappears on the echo.
- Settings page offers "Arrange existing work now" when switching into an automatic mode. It runs
  `placeAutoPriority` for every live assigned card in the workspace for every member, in score order,
  stopping at each person's cap. Without this, switching modes only affects future assignments, which
  reads as "it does nothing".

### 7. Contracts to update together

- `packages/shared/src/schema/workspace.ts`, `card-priority.ts` (tuples, columns, checks), then
  `pnpm db:generate`, review SQL, `pnpm db:migrate`.
- `packages/shared/src/dto/workspaces.ts` (patch body + response), `card-priorities.ts`
  (`source`, `reason` on `WorkPriorityItem`), `public-api.ts` where the workspace and priority shapes
  are mirrored, and the OpenAPI docs under `apps/api/src/docs`.
- `@kanera/sdk` and `apps/mcp` types for the new fields. Settings stay UI-only per the MCP convention.

### 8. Tests

E2E first, as the policy says, each with its artifact:

1. Workspace in `insert` mode: assign a card with no due date to a member whose queue holds one
   manual entry. Expect it below the manual entry, marked auto.
2. Assign an overdue card next. Expect it above the undated auto card and still below the manual one.
3. Drag the auto card above the manual one. Expect the marker gone and the next auto insert to leave
   it alone.
4. Workspace in `manual` mode: assignment adds nothing to the queue.
5. `arrange` mode: set a due date on a queued auto card to yesterday. Expect it to climb above the
   other auto entries without moving the manual one.
6. Automation `add_assignees` in an `insert` workspace places the card for the automation's target.
7. `arrange` mode: on an undated queued card, assign a checklist item to the target with a due date
   of tomorrow. Expect the card to climb into the due-soon tier with a "checklist item due" reason;
   the same item assigned to someone else leaves the card where it was.

Isolated tests only where E2E cannot see the failure: a unit test for the comparator (tier
boundaries, timezone edge at midnight, slot order, null handling) and an integration test for the cap
no-op and the "already queued" guard under concurrent assignment.

## Decisions needed before building

1. **Default mode.** Proposal: `manual` everywhere, so existing users see no change. Alternative:
   `insert` for newly created workspaces only.
2. **List direction.** Proposal: later list first. Alternative: earlier list first, or a per-list
   weight (more work, defer).
3. **Manual entries as fixed points.** Proposal: auto never moves a manual row and threads around it.
   Alternative: auto block always sits below every manual row (simpler, but an overdue card then
   hides under a stale manual pick).
4. **Ship `arrange` in v1** or start with `insert` only. Proposal: build both; `arrange` is a small
   extension once scoring and slots exist.
