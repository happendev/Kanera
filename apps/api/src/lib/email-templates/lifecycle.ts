import type { Locale } from "@kanera/shared/locales";
import type { LifecycleEmailQueueData, LifecycleEmailQueueType } from "@kanera/shared/schema";
import { escapeHtml } from "../html-escape.js";
import { serverMessages } from "../i18n/messages/index.js";
import type { LeadLine } from "../i18n/messages/types.js";
import { button, emailLayout, fallbackLink, heading, mutedHtml, paragraph, paragraphHtml, richHtml, strong, text } from "./layout.js";

export type LifecycleEmailParams = LifecycleEmailQueueData & { locale: Locale };

// Lifecycle copy follows the marketing lifecycle-communication plan: one purpose and one action per
// email. Every input is a name, a link, or a structural flag; none of it is derived from board content.

/** Shared by the queue row and the rendered <title> so the two cannot drift. */
export function lifecycleEmailSubject(type: LifecycleEmailQueueType, params: LifecycleEmailParams): string {
  const m = serverMessages(params.locale).email.lifecycle;
  switch (type) {
    case "lifecycle_no_board":
      return m.noBoard.subject;
    case "lifecycle_invite_team":
      return m.inviteTeam.subject;
    case "lifecycle_early_success":
      return params.nextStep === "automations" ? m.earlySuccess.subjectAutomations : m.earlySuccess.subjectMyCards;
    case "lifecycle_inactive":
      return m.inactive.subject;
    case "lifecycle_active_checkin":
      return m.activeCheckin.subject;
  }
}

export function lifecycleNoBoardEmail(params: LifecycleEmailParams): string {
  const m = serverMessages(params.locale).email.lifecycle.noBoard;
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_no_board", params),
    preheader: m.preheader,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    lines: m.lines,
    cta: m.cta,
  });
}

export function lifecycleInviteTeamEmail(params: LifecycleEmailParams): string {
  const m = serverMessages(params.locale).email.lifecycle.inviteTeam;
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_invite_team", params),
    preheader: m.preheader,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    lines: m.lines,
    cta: m.cta,
  });
}

export function lifecycleEarlySuccessEmail(params: LifecycleEmailParams): string {
  const m = serverMessages(params.locale).email.lifecycle.earlySuccess;
  const automations = params.nextStep === "automations";
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_early_success", params),
    preheader: automations ? m.preheaderAutomations : m.preheaderMyCards,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    lines: automations ? m.linesAutomations : m.linesMyCards,
    cta: automations ? m.ctaAutomations : m.ctaMyCards,
  });
}

export function lifecycleInactiveEmail(params: LifecycleEmailParams): string {
  const m = serverMessages(params.locale).email.lifecycle.inactive;
  const feedbackEmail = params.feedbackEmail;
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_inactive", params),
    preheader: m.preheader,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    linesHtml: [
      leadLine(m.setup),
      leadLine(m.timing),
      `${strong(m.somethingWrong.lead)} ${feedbackEmail
        ? richHtml((s) => m.somethingWrong.withFeedback(s), { email: feedbackLink(feedbackEmail) })
        : text(m.somethingWrong.withoutFeedback)}`,
      leadLine(m.wrongTool),
    ],
    cta: m.cta,
  });
}

export function lifecycleActiveCheckinEmail(params: LifecycleEmailParams): string {
  const m = serverMessages(params.locale).email.lifecycle.activeCheckin;
  const feedbackEmail = params.feedbackEmail;
  return lifecycleLayout(params, {
    subject: lifecycleEmailSubject("lifecycle_active_checkin", params),
    preheader: m.preheader,
    title: m.title,
    intro: m.intro({ firstName: firstName(params.displayName), org: params.orgName }),
    linesHtml: [
      leadLine(m.tip),
      leadLine(params.onFreePlan ? m.freePlan : m.growing),
      feedbackEmail
        ? `${strong(m.feedback.lead)} ${richHtml((s) => m.feedback.body(s), { email: feedbackLink(feedbackEmail) })}`
        : null,
    ],
    cta: m.cta,
  });
}

function lifecycleLayout(params: LifecycleEmailParams, options: {
  subject: string;
  preheader: string;
  title: string;
  intro: string;
  lines?: readonly string[];
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
    ${fallbackLink(params.ctaUrl, params.locale)}
    ${mutedHtml(text(serverMessages(params.locale).email.lifecycle.footerNote), "18px 0 0 0")}
  `;
  return emailLayout({ locale: params.locale, subject: options.subject, preheader: options.preheader, body, unsubscribeUrl: params.unsubscribeUrl });
}

/** A bold lead-in and the rest of the paragraph, both escaped. */
function leadLine(line: LeadLine): string {
  return `${strong(line.lead)} ${text(line.body)}`;
}

function feedbackLink(email: string): string {
  const safe = escapeHtml(email);
  return `<a href="mailto:${safe}" class="email-link" style="color:#0d9488;font-weight:600;text-decoration:underline;">${safe}</a>`;
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] || displayName;
}
