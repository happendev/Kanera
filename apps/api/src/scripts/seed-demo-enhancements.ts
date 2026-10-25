import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  boards, workspaces, lists, cards, cardAssignees, cardCustomFieldValues, customFields,
  cardChecklistItems, cardChecklists, cardLabels, cardLabelAssignments, cardRelations,
  boardSeparators, cardPriorities, notes,
} from "@kanera/shared/schema";
import type { ColorToken } from "@kanera/shared/colors";
import { addWorkingDays, dateKeyOf, dayNumber } from "@kanera/shared/schedule";
import type { TxOnly } from "../db.js";
import { allocateCardKeys } from "../lib/card-keys.js";
import { type seedCalendar, MARKETING_DEADLINES, OTHER_DEADLINES } from "./seed-calendar.js";

const ARCHIVED = [1, 2, 23, 24, 44, 45, 63, 66, 83, 84, 104, 105];
const BUDGETS: Record<number, number> = {
  5: 600, 6: 300, 7: 1800, 8: 900, 9: 600, 10: 2400, 11: 300, 16: 1200,
  27: 450, 31: 750, 32: 450, 50: 1200, 70: 900, 71: 450, 72: 300, 73: 300,
  88: 1600, 89: 600, 90: 600, 91: 300, 106: 450, 107: 750, 109: 1200, 110: 900, 111: 600,
};
const QUEUES: Record<string, number[]> = {
  amelia: [34, 12, 92], ben: [5, 10, 74, 89, 76], grace: [9, 57, 73, 91, 71],
  leo: [11, 50, 90], nina: [31, 109, 110], omar: [86, 95, 88], zoe: [8, 32, 70],
};
const BOARD_ORDER = ["Autumn Campaign Launch", "Website & Landing Pages", "Content & Customer Stories", "Brand Refresh", "Events & Partnerships", "Marketing Requests"];
const CAMPAIGNS: Record<string, string> = {
  "Autumn Campaign Launch": "Autumn launch", "Brand Refresh": "Brand refresh",
  "Website & Landing Pages": "Website improvements", "Content & Customer Stories": "Editorial programme",
  "Events & Partnerships": "Webinar programme", "Marketing Requests": "Sales enablement",
};
const GROUPS: [string, string, string, (number | string)[]][] = [
  ["Autumn Campaign Launch", "Ready to Start", "Scheduling & measurement", [120, 6, "NEW-LAUNCH"]],
  ["Autumn Campaign Launch", "In Progress", "Launch preparation", [5, 8, 9, 10, 11]],
  ["Brand Refresh", "Ready to Start", "Brand foundations", [29, 28, 27]],
  ["Brand Refresh", "Ready to Start", "Sales rollout", [30]],
  ["Brand Refresh", "In Progress", "Templates & voice", [31, 32]],
  ["Website & Landing Pages", "Ready to Start", "Launch support", [47, 49, 55, 56]],
  ["Website & Landing Pages", "Ready to Start", "Website improvements", [48, 51, 52, 53, 54, 46]],
  ["Content & Customer Stories", "Ready to Start", "Launch & customer story", [68, 72, 74]],
  ["Content & Customer Stories", "Ready to Start", "Editorial planning", [67, 69, 71, 75]],
  ["Events & Partnerships", "Ready to Start", "Webinar preparation", [91, "NEW-REHEARSAL", "NEW-RECORDING"]],
  ["Events & Partnerships", "Ready to Start", "Future events", [87]],
  ["Marketing Requests", "Ideas & Requests", "Needs triage", [102]],
  ["Marketing Requests", "Ideas & Requests", "Sales requests", [101, 103]],
  ["Marketing Requests", "Ready to Start", "Sales enablement", [106, 107, 111, 112]],
  ["Marketing Requests", "Ready to Start", "Recruitment", [108, 110]],
];

/** Only called inside a fresh seed transaction. It is not a live-data migration or a reset API. */
export async function enhanceDemoSeed(tx: TxOnly, input: {
  clientId: string; userIds: ReadonlyMap<string, string>; calendar: ReturnType<typeof seedCalendar>;
}) {
  const { calendar, userIds } = input;
  const at = calendar.instant;
  const boardRows = await tx.select({ board: boards, workspace: workspaces }).from(boards)
    .innerJoin(workspaces, eq(workspaces.id, boards.workspaceId)).where(eq(workspaces.clientId, input.clientId));
  const marketing = boardRows.find(({ workspace }) => workspace.name === "Marketing & Creative")!.workspace;
  const marketingBoards = boardRows.filter(({ board }) => board.workspaceId === marketing.id).map(({ board }) => board);
  const listRows = await tx.select().from(lists).where(eq(lists.workspaceId, marketing.id));
  const listId = (name: string) => {
    const list = listRows.find((row) => row.name === name);
    if (!list) throw new Error(`Missing demo list ${name}`);
    return list.id;
  };
  const boardId = (name: string) => marketingBoards.find((row) => row.name === name)!.id;
  const marketingCards = await tx.select().from(cards).where(eq(cards.workspaceId, marketing.id));
  const byNumber = new Map(marketingCards.map((card) => [card.number, card]));
  const card = (number: number) => {
    const found = byNumber.get(number);
    if (!found) throw new Error(`Missing authored Marketing card ${number}`);
    return found;
  };
  const update = async (number: number, values: Partial<typeof cards.$inferInsert>) => {
    await tx.update(cards).set(values).where(eq(cards.id, card(number).id));
    Object.assign(card(number), values);
  };
  const fieldRows = await tx.select().from(customFields).where(eq(customFields.workspaceId, marketing.id));
  const field = async (row: typeof cards.$inferSelect, name: string, value: string | number | boolean) => {
    const fieldId = fieldRows.find((item) => item.name === name)!.id;
    const values = { valueText: typeof value === "string" ? value : null, valueNumber: typeof value === "number" ? String(value) : null,
      valueCheckbox: typeof value === "boolean" ? value : null, updatedAt: at };
    await tx.insert(cardCustomFieldValues).values({ cardId: row.id, fieldId, ...values })
      .onConflictDoUpdate({ target: [cardCustomFieldValues.cardId, cardCustomFieldValues.fieldId], set: values });
  };
  const setOwner = async (row: typeof cards.$inferSelect, owner?: string) => {
    const current = await tx.select().from(cardAssignees).where(eq(cardAssignees.cardId, row.id));
    const desired = owner ? userIds.get(owner)! : undefined;
    if (current.length === (desired ? 1 : 0) && (!desired || current[0]!.userId === desired)) return;
    await tx.delete(cardAssignees).where(eq(cardAssignees.cardId, row.id));
    if (desired) await tx.insert(cardAssignees).values({ cardId: row.id, userId: desired, assignedAt: at });
  };
  const aliasCards = new Map<string, typeof cards.$inferSelect>();
  const created: { alias: string; id: string; key: string }[] = [];
  const ensureCard = async (alias: string, title: string, boardName: string, owner: string, offset: number | null, description: string) => {
    // Seed identities are allocated by the same workspace counter as application-created cards.
    let row = marketingCards.find((item) => item.title === title);
    if (!row) {
      const [identity] = await allocateCardKeys(tx, marketing.id, 1);
      [row] = await tx.insert(cards).values({ ...identity!, title, description, boardId: boardId(boardName),
        listId: listId(alias === "AUTOMATION" ? "In Progress" : "Ready to Start"), position: "5000",
        dueDateLocalDate: offset === null ? null : calendar.business(offset), dueDateSlot: null,
        dueDateTimezone: offset === null ? null : "Europe/London", createdById: userIds.get(owner)!, createdAt: at, updatedAt: at,
      }).returning();
      marketingCards.push(row!);
      byNumber.set(row!.number, row!);
      created.push({ alias, id: row!.id, key: row!.key });
      await setOwner(row!, owner);
    }
    aliasCards.set(alias, row!);
    await field(row!, "Campaign", alias === "NEW-REHEARSAL" || alias === "NEW-RECORDING" ? "Webinar programme" : "Autumn launch");
    await field(row!, "Approved", false);
    return row!;
  };
  await ensureCard("EMAIL", "Schedule the launch-day customer email", "Autumn Campaign Launch", "amelia", 6,
    `Schedule on ${calendar.label(6)} for sending on ${calendar.label(7)} at 09:00 Europe/London, only after ${card(13).key} is approved. Confirm audience exclusions, consent and tracking. Scheduling and sending are separate actions.`);
  const newLaunch = await ensureCard("NEW-LAUNCH", "Coordinate launch-day publishing and checks", "Autumn Campaign Launch", "ben", 7,
    `Coordinate channel go-live on ${calendar.label(7)} at 09:00 Europe/London after readiness and email scheduling. Verify publishing and tracking on each channel, and record exceptions.`);
  const rehearsal = await ensureCard("NEW-REHEARSAL", "Run the customer webinar rehearsal", "Events & Partnerships", "omar", 11,
    `Rehearse on ${calendar.label(11)} at 14:00 Europe/London after the speaker confirms their holds. Test speaker handoffs, audio, backup recording and moderation for the ${calendar.label(13)} broadcast.`);
  const recording = await ensureCard("NEW-RECORDING", "Send the webinar recording and follow-up", "Events & Partnerships", "grace", 14,
    `Follow up on ${calendar.label(14)} after the broadcast. Use the sequence in ${card(91).key}, verify the actual recording link and respect partner opt-ins before sending.`);
  const automation = await ensureCard("AUTOMATION", "Design the campaign overview document", "Marketing Requests", "nina", null,
    `Prepare a concise overview covering audience, approved messaging, channel plan and launch dates (${calendar.label(7)}). Use ${card(109).key} as a content reference. The overview is not ready until a real document exists.`);
  const [design] = await tx.select().from(cardLabels).where(and(eq(cardLabels.workspaceId, marketing.id), eq(cardLabels.name, "Design")));
  await tx.insert(cardLabelAssignments).values({ cardId: automation.id, labelId: design!.id, assignedAt: at }).onConflictDoNothing();

  for (const number of ARCHIVED) await update(number, { archivedAt: card(number).archivedAt ?? at });
  for (const number of [14, 64, 68, 69, 71, 72, 74, 75, 77]) await update(number, { coverAttachmentId: null });
  const [blocked] = await tx.select().from(cardLabels).where(and(eq(cardLabels.workspaceId, marketing.id), eq(cardLabels.name, "Blocked")));
  await tx.delete(cardLabelAssignments).where(and(eq(cardLabelAssignments.cardId, card(76).id), eq(cardLabelAssignments.labelId, blocked!.id)));
  await tx.delete(cardLabelAssignments).where(and(eq(cardLabelAssignments.cardId, card(15).id), eq(cardLabelAssignments.labelId, blocked!.id)));
  for (const number of [30, 51, 52, 53, 54, 55, 56, 71, 72, 74, 75, 91, 110, 111, 112, 120]) await update(number, { listId: listId("Ready to Start") });
  for (const number of [88, 113]) await update(number, { listId: listId("Waiting on Others") });
  for (const number of [5, 86]) await update(number, { listId: listId("In Progress") });
  await setOwner(card(102));
  // The approved WIP/budget example explicitly identifies Ben as the video owner.
  await setOwner(card(10), "ben");
  // Only a review-wall bitmap exists in the source assets, not the required final exports.
  // Keep source comments and attachments while refusing to manufacture a sign-off.
  await update(7, { completedAt: null, listId: listId("Waiting on Others") });

  const descriptions: Record<number, string> = {
    5: `Messaging is signed off in ${card(15).key}. Insert it into the brief, publish version 1.0 and retire the workshop draft.`,
    7: `Final exports are required: desktop/mobile hero, email header, three social formats and partner lockup. Final campaign-package approval remains with Amelia in ${card(12).key}. The attached review image does not establish that these exports exist. Missing final exports block completion. Keep product UI out of the artwork; Leo supplies screenshots separately.`,
    14: `Product messaging is signed off in ${card(15).key}; ${card(12).key} remains the open launch-approval dependency. Ben coordinates readiness with Amelia; Grace owns the social schedule; Leo verifies web/tracking. Readiness is due ${calendar.label(6)} for the ${calendar.label(7)} launch at 09:00 Europe/London.`,
    15: `Messaging is complete and signed off; this task is not blocked. ${card(5).key} can proceed with the approved product promise.`,
    19: `Launch: ${calendar.label(7)}, 09:00 Europe/London. Final campaign approval: ${calendar.label(4)}. Change freeze: ${calendar.label(5)}. Readiness and email scheduling: ${calendar.label(6)}.`,
    50: `The outline is approved; final landing-page copy in ${card(8).key} is still being written. Build due ${calendar.label(2)}; review and accessibility due ${calendar.label(3)}. Use responsive artwork, persistent campaign source, accessible form errors and a no-quotation fallback.`,
    68: `Validate remaining draft questions and permissions following the earlier Northshore customer conversation. Tailor approved questions to the remaining gaps and confirm consent before recording. Plan a 45-minute follow-up on adoption and measurable changes in Northshore’s move from departmental trackers to one shared workflow.`,
    70: `Draft from the earlier Northshore customer conversation and verified records; ${card(68).key} resolves remaining gaps. Draft ${calendar.label(3)}, editorial review ${calendar.label(4)}, customer sign-off ${calendar.label(5)}. Keep the five-trackers story and three-week parallel migration, use verified numbers and mark quotations awaiting approval.`,
    76: `Customer image/quotation approval remains outstanding. Full-story sign-off follows editorial review ${card(74).key}; do not publish before both approvals. The review covers two quotations, team-size wording and screenshots.`,
    88: `Deliver the webinar on ${calendar.label(13)} at 14:00 Europe/London. Rehearsal is ${calendar.label(11)} at 14:00; the speaker hold in ${card(95).key} remains outstanding. Recording distribution is a separate task (${recording.key}). Confirm partner demo-account permissions as part of delivery readiness.`,
    95: `Organisers agreed the event date (${calendar.label(13)} at 14:00 Europe/London), but the guest speaker accepted in principle; their rehearsal (${calendar.label(11)} at 14:00) and broadcast holds still need confirmation by ${calendar.label(1)}.`,
    97: `Completed organiser agreement covers the ${calendar.label(13)} event and proposed ${calendar.label(11)} rehearsal, both at 14:00 Europe/London. It does not mean the speaker personally confirmed.`,
  };
  for (const [number, description] of Object.entries(descriptions)) {
    const existing = card(Number(number)).description ?? "";
    const links = [...new Set(existing.match(/https?:\/\/[^\s)]+/g) ?? [])];
    await update(Number(number), { description: [description, ...links].join("\n\n") });
  }
  await update(68, { title: "Prepare the Northshore follow-up interview" });
  await update(88, { title: "Deliver the autumn customer webinar" });
  const checklistRows = await tx.select({ item: cardChecklistItems, cardId: cardChecklists.cardId }).from(cardChecklistItems)
    .innerJoin(cardChecklists, eq(cardChecklists.id, cardChecklistItems.checklistId))
    .where(inArray(cardChecklists.cardId, [card(14).id, card(68).id, card(88).id]));
  for (const { item, cardId: parentId } of checklistRows) {
    if (parentId === card(14).id || parentId === card(88).id && item.text === "Book speaker rehearsal") {
      const checked = parentId === card(14).id && item.text === "Confirm final product messaging";
      if (Boolean(item.completedAt) !== checked) await tx.update(cardChecklistItems).set({ completedAt: checked ? at : null,
        completedById: checked ? userIds.get("ben")! : null, updatedAt: at }).where(eq(cardChecklistItems.id, item.id));
    }
    if (parentId === card(68).id && item.text === "Tailor approved question set") await tx.update(cardChecklistItems)
      .set({ text: "Tailor approved questions for remaining draft gaps" }).where(eq(cardChecklistItems.id, item.id));
  }

  for (const row of marketingCards.filter((item) => !item.completedAt && !item.archivedAt && item.id !== automation.id)) {
    const board = marketingBoards.find((item) => item.id === row.boardId)!;
    let campaign = CAMPAIGNS[board.name]!;
    for (const [name, numbers] of [
      ["Autumn launch", [31, 50, 55, 56, 72, 73]], ["Northshore customer story", [65, 68, 70, 74, 76]],
      ["Customer newsletter", [71, 75]], ["Recruitment campaign", [108, 110, 113, 115]],
      ["Product overview", [109, 112]], ["Customer onboarding", [102]],
    ] as const) if ((numbers as readonly number[]).includes(row.number)) campaign = name;
    await field(row, "Campaign", campaign);
  }
  for (const [number, amount] of Object.entries(BUDGETS)) await field(card(Number(number)), "Budget", amount);

  const relate = async (source: typeof cards.$inferSelect, target: typeof cards.$inferSelect) => {
    await tx.insert(cardRelations).values({ workspaceId: marketing.id, sourceCardId: source.id, targetCardId: target.id,
      kind: "blocks", createdById: userIds.get("ben")!, createdAt: at }).onConflictDoNothing();
  };
  await relate(card(13), card(120));
  await relate(card(14), newLaunch); await relate(card(120), newLaunch);
  await relate(card(95), rehearsal); await relate(card(88), recording);

  for (const [index, name] of BOARD_ORDER.entries()) await tx.update(boards).set({ position: String((index + 1) * 1000) }).where(eq(boards.id, boardId(name)));
  const colors: Record<string, ColorToken> = { "Ideas & Requests": "gray", "Ready to Start": "teal", "In Progress": "blue", "Review & Approval": "violet", "Waiting on Others": "amber", Done: "green" };
  for (const row of listRows) await tx.update(lists).set({ color: colors[row.name] }).where(eq(lists.id, row.id));
  const positions = new Map<string, number>();
  for (const [boardName, listName, title, numbers] of GROUPS) {
    const board = boardId(boardName); const list = listId(listName); const scope = `${board}:${list}`;
    let position = positions.get(scope) ?? 0;
    const separator = await tx.select().from(boardSeparators).where(and(eq(boardSeparators.boardId, board), eq(boardSeparators.listId, list), eq(boardSeparators.title, title)));
    position += 1000;
    if (!separator.length) await tx.insert(boardSeparators).values({ boardId: board, listId: list, title, position: String(position), createdById: userIds.get("ben")!, createdAt: at, updatedAt: at });
    else await tx.update(boardSeparators).set({ position: String(position) }).where(eq(boardSeparators.id, separator[0]!.id));
    for (const number of numbers) {
      const row = typeof number === "number" ? card(number) : aliasCards.get(number)!;
      position += 1000;
      await tx.update(cards).set({ position: String(position) }).where(eq(cards.id, row.id));
    }
    positions.set(scope, position);
  }
  for (const [owner, numbers] of Object.entries(QUEUES)) {
    const targetUserId = userIds.get(owner)!;
    const existing = await tx.select().from(cardPriorities).where(eq(cardPriorities.targetUserId, targetUserId));
    if (existing.length === numbers.length && existing.sort((a, b) => Number(a.position) - Number(b.position)).every((row, index) => row.cardId === card(numbers[index]!).id)) continue;
    await tx.delete(cardPriorities).where(eq(cardPriorities.targetUserId, targetUserId));
    await tx.insert(cardPriorities).values(numbers.map((number, index) => ({ targetUserId, cardId: card(number).id,
      position: String((index + 1) * 1000), createdById: targetUserId, createdAt: at, updatedAt: at })));
  }

  const offsetMap: Record<string, string> = {};
  for (const { board, workspace } of boardRows) {
    const rows = await tx.select().from(cards).where(and(eq(cards.boardId, board.id), isNull(cards.completedAt), isNull(cards.archivedAt)));
    for (const row of rows) {
      if (row.id === automation.id) continue;
      const offset = workspace.id === marketing.id ? MARKETING_DEADLINES[row.number] : OTHER_DEADLINES[workspace.name]?.[row.number];
      let due: string | undefined;
      if (workspace.id === marketing.id && row.number === 9) { due = calendar.previous(1); offsetMap[row.key] = "P+1"; }
      else if (offset !== undefined) { due = offset < 0 ? calendar.previous(-offset) : calendar.business(offset); offsetMap[row.key] = `${offset < 0 ? "P" : "B"}+${Math.abs(offset)}`; }
      else if (row.id === newLaunch.id || row.id === rehearsal.id || row.id === recording.id) {
        const n = row.id === newLaunch.id ? 7 : row.id === rehearsal.id ? 11 : 14;
        due = calendar.business(n); offsetMap[row.key] = `B+${n}`;
      } else if (row.number === 7 && workspace.id === marketing.id) { due = calendar.business(2); offsetMap[row.key] = "B+2 (missing exports)"; }
      else if (row.dueDateLocalDate) throw new Error(`Dated fixture ${row.key} needs an explicit business-day offset (${workspace.name}).`);
      if (due) await tx.update(cards).set({ dueDateLocalDate: due, dueDateSlot: null, dueDateTimezone: "Europe/London",
        startDateLocalDate: row.startDateLocalDate && row.startDateLocalDate > due ? dateKeyOf(addWorkingDays(dayNumber(due), -1)) : row.startDateLocalDate,
      }).where(eq(cards.id, row.id));
      if (workspace.name === "Development Team" && row.number === 7) {
        await tx.update(cards).set({ startDateLocalDate: calendar.business(6) }).where(eq(cards.id, row.id));
      }
      if (workspace.name === "Launch Checklist" && row.number <= 5) await setOwner(row, "marcus");
    }
  }
  // Enforce finish-to-start ordering for the authored Marketing chains without changing their due dates.
  for (const [source, target] of [[8, 50], [95, 88], [96, 90], [115, 113], [10, 12], [12, 14], [13, 120]] as const) {
    const due = MARKETING_DEADLINES[source]!;
    await update(target, { startDateLocalDate: calendar.business(due + 1) });
  }
  await tx.update(cards).set({ startDateLocalDate: calendar.business(7) }).where(eq(cards.id, newLaunch.id));
  await tx.update(cards).set({ startDateLocalDate: calendar.business(11) }).where(eq(cards.id, rehearsal.id));
  await tx.update(cards).set({ startDateLocalDate: calendar.business(14) }).where(eq(cards.id, recording.id));
  const noteRows = await tx.select().from(notes).where(eq(notes.workspaceId, marketing.id));
  for (const row of noteRows) {
    let content = row.content;
    if (row.title === "Autumn Campaign Launch Plan") content = `## Launch at a glance\n\nMessaging is complete. Final approval ${card(12).key} remains outstanding.\n\n${/!\[[^\]]*\]\([^\n]+\)/.exec(row.content)?.[0] ?? ""}\n\n| Milestone | Date (Europe/London) |\n| --- | --- |\n| Final campaign approval | ${calendar.label(4)} |\n| Change freeze | ${calendar.label(5)} |\n| Readiness and email scheduling | ${calendar.label(6)} |\n| Launch | ${calendar.label(7)}, 09:00 |\n\nBen coordinates; Amelia approves; Nina owns graphics; Zoe owns copy; Leo owns web/tracking; Grace owns schedule/social; Omar owns partners. Done means approved deliverables and passed checks. Update the main launch card when dependencies change, record channel go-live confirmations and hold the T+12h performance check before changing spend.`;
    if (row.title === "Launch Week Run of Show") content = `## Launch week\n\n- ${calendar.label(4)}: final approvals, including landing-page copy.\n- ${calendar.label(5)}: change freeze, tracking/form checks and partner handoff.\n- ${calendar.label(6)}: readiness, email scheduling and social schedule checks.\n- ${calendar.label(7)}, 09:00 Europe/London: launch, monitor and record exceptions.\n\nBen coordinates the go/no-go call with Amelia. Grace maintains the schedule; channel owners report blockers on the main launch card. Pause distribution if approval, consent, tracking or the form is not ready.`;
    if (row.title === "Marketing Team Operating Guide" && !content?.includes("planned allocation in EUR")) content += "\n\n## Reporting fields\n\nBudget is a planned allocation in EUR, not actual spend. Campaign groups delivery work across boards. Leave unknown allocations blank.";
    if (content !== row.content) {
      const related = row.content.split("\n").filter((line) => line.startsWith("Related ") && !content.includes(line));
      if (related.length) content += `\n\n${related.join("\n")}`;
    }
    if (content !== row.content) await tx.update(notes).set({ content, updatedAt: at }).where(eq(notes.id, row.id));
  }
  return { referenceDate: calendar.date, created, offsetMap,
    warnings: ["MARKETINGC-7 remains incomplete: desktop/mobile hero, email header, three social formats and partner lockup exports are missing. Permanent totals are 111 unarchived = 82 active + 29 completed until the exports can be verified; the temporary automation card adds one.", "Ben’s active launch set also includes NEW-LAUNCH, as requested; its blank Budget leaves the total at EUR 3000. The three-card set in the brief describes the pre-existing cards only.", "No genuine Claude history is available in the local fixture source. Agent successes and unread inbox activity are not fabricated; use real application actions for demonstrations."] };
}
