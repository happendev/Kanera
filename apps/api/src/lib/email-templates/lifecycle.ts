import type { LifecycleEmailQueueData, LifecycleEmailQueueType } from "@kanera/shared/schema";
import { escapeHtml } from "../html-escape.js";
import { button, emailLayout, fallbackLink, heading, mutedHtml, paragraph, paragraphHtml, strong } from "./layout.js";

export type LifecycleEmailParams = LifecycleEmailQueueData;

// Lifecycle copy follows the marketing lifecycle-communication plan: one purpose and one action per
// email. Every input is a name, a link, or a structural flag; none of it is derived from board content.

/** Shared by the queue row and the rendered <title> so the two cannot drift. */
export function lifecycleEmailSubject(type: LifecycleEmailQueueType, params: LifecycleEmailParams): string {
  switch (type) {
    case "lifecycle_no_board":
      return "Start with one simple board";
    case "lifecycle_invite_team":
      return "Kanera works best with your team";
    case "lifecycle_early_success":
      return params.nextStep === "automations"
        ? "Your next step in Kanera: automate a routine move"
        : "Your next step in Kanera: see all your work in one place";
    case "lifecycle_inactive":
      return "Is Kanera working for you?";
    case "lifecycle_active_checkin":
      return "How is Kanera working for your team?";
  }
}

export function lifecycleNoBoardEmail(params: LifecycleEmailParams): string {
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_no_board", params),
    preheader: "A small first board is the quickest way to see whether Kanera fits.",
    title: "Start with one simple board",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} is set up but doesn't have a board yet.`,
    lines: [
      "You don't need to plan your whole process first. Pick one piece of work your team is doing this week, and give it three lists: To do, Doing, and Done.",
      "Add a few real cards and move them as the work moves. Once that feels natural, add more boards to the same workspace. They all share its lists and fields, so nothing needs setting up twice.",
      "Already tracking work in Trello or a spreadsheet? Import it from your workspace settings instead of starting from scratch.",
    ],
    cta: "Create your first board",
  });
}

export function lifecycleInviteTeamEmail(params: LifecycleEmailParams): string {
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_invite_team", params),
    preheader: "Invite the people you work with so assignments, comments and due dates reach them.",
    title: "Bring in the people you work with",
    intro: `Hi ${firstName(params.displayName)}, you've started a board in ${params.orgName}. Right now you're the only member.`,
    lines: [
      "Kanera pays off once the people doing the work are on the board too: you can assign cards to them, mention them in comments, and see who is doing what without asking.",
      "Invite teammates as members of the whole organisation, or invite someone outside it as a guest on a single board.",
    ],
    cta: "Invite your team",
  });
}

export function lifecycleEarlySuccessEmail(params: LifecycleEmailParams): string {
  const automations = params.nextStep === "automations";
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_early_success", params),
    preheader: automations
      ? "Let Kanera handle the repetitive moves, so your boards stay up to date."
      : "My Cards gathers everything assigned to you across boards.",
    title: "Your boards are taking shape",
    intro: `Hi ${firstName(params.displayName)}, ${params.orgName} now has real work moving through Kanera. Here's one thing worth trying next.`,
    lines: automations
      ? [
        "Automations handle the routine moves for you. For example, they can mark a card complete when it reaches Done, or assign a reviewer when a card enters Review.",
        "Start with one rule for a step your team repeats every day. You can switch it off at any time.",
      ]
      : [
        "My Cards shows every card assigned to you across all your boards in one list, so you can plan your day without opening each board.",
        "Add the cards you'll tackle first to Up next, and keep them in order as priorities change.",
      ],
    cta: automations ? "Set up an automation" : "Open My Cards",
  });
}

export function lifecycleInactiveEmail(params: LifecycleEmailParams): string {
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_inactive", params),
    preheader: "No one in your organisation has used Kanera for a couple of weeks. We'd like to know why.",
    title: "Has something got in the way?",
    intro: `Hi ${firstName(params.displayName)}, no one in ${params.orgName} has used Kanera for a couple of weeks. Here are some common reasons and what can help:`,
    linesHtml: [
      `${strong("Setup took too long.")} Import an existing Trello board or spreadsheet from workspace settings instead of building from scratch.`,
      `${strong("The timing isn't right.")} Your boards and cards are safe, and they'll be waiting when you're ready.`,
      `${strong("Something didn't work the way you expected.")} ${params.feedbackEmail ? `Tell us at ${feedbackLink(params.feedbackEmail)}. Specific feedback is the most useful thing you can send us.` : "Tell us what it was. Specific feedback is the most useful thing you can send us."}`,
      `${strong("It isn't the right tool.")} That's fine. You can export any board from its menu, or delete your organisation from organisation settings.`,
    ],
    cta: "Open Kanera",
  });
}

export function lifecycleActiveCheckinEmail(params: LifecycleEmailParams): string {
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_active_checkin", params),
    preheader: "A quick check-in, one tip, and an easy way to tell us what to improve.",
    title: "A quick check-in",
    intro: `Hi ${firstName(params.displayName)}, your team in ${params.orgName} has been using Kanera together for a while now. Thank you.`,
    linesHtml: [
      `${strong("One tip:")} Team Cards shows what everyone is working on across all your boards, without opening each one.`,
      params.onFreePlan
        ? `${strong("When you need more room:")} Kanera Pro adds unlimited boards, members and automations, plus guest access, API access and webhooks. Compare plans in account settings.`
        : `${strong("Growing the team?")} You can invite more members, or add a client or contractor as a guest on just the boards they need.`,
      params.feedbackEmail
        ? `${strong("What should we improve?")} Email ${feedbackLink(params.feedbackEmail)}. We read every message.`
        : null,
    ],
    cta: "Open Kanera",
  });
}

function lifecycleLayout(params: LifecycleEmailParams, options: {
  subject: string;
  preheader: string;
  title: string;
  intro: string;
  lines?: string[];
  /** Pre-escaped HTML lines; callers build them from escaped helpers only. */
  linesHtml?: Array<string | null>;
  cta: string;
}): string {
  const lines = options.lines?.map((line) => paragraph(line, "0 0 14px 0")).join("") ?? "";
  const linesHtml = options.linesHtml?.filter((line): line is string => line !== null).map((line) => paragraphHtml(line, "0 0 14px 0")).join("") ?? "";
  const body = `
    ${heading(options.title)}
    ${paragraph(options.intro)}
    ${lines}
    ${linesHtml}
    ${button({ href: params.ctaUrl, label: options.cta })}
    ${fallbackLink(params.ctaUrl)}
    ${mutedHtml("You can turn off onboarding and account tips under Settings, then Notifications.", "18px 0 0 0")}
  `;
  return emailLayout({ subject: options.subject, preheader: options.preheader, body, unsubscribeUrl: params.unsubscribeUrl });
}

function feedbackLink(email: string): string {
  const safe = escapeHtml(email);
  return `<a href="mailto:${safe}" class="email-link" style="color:#0d9488;font-weight:600;text-decoration:underline;">${safe}</a>`;
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] || displayName;
}
