import type { Locale } from "@kanera/shared/locales";
import type { OrganisationDeletedEmailQueueData } from "@kanera/shared/schema";
import { serverMessages } from "../i18n/messages/index.js";
import { emailLayout, heading, mailtoLink, mutedHtml, paragraph, richHtml, text } from "./layout.js";

export type OrganisationDeletedEmailParams = OrganisationDeletedEmailQueueData & { locale: Locale };

/**
 * Sent to every member when an organisation is deleted: it disappears from their sidebar at once,
 * and the person who deleted it gets a record that the purge cannot be undone. No button: there is
 * nothing left to open.
 */
export function organisationDeletedEmail(params: OrganisationDeletedEmailParams): string {
  const m = serverMessages(params.locale).email.organisationDeleted;
  const firstName = params.displayName.split(" ")[0] || params.displayName;
  const intro = params.deletedByName
    ? m.introOther({ firstName, actor: params.deletedByName, org: params.orgName, when: params.deletedAtLabel })
    : m.introSelf({ firstName, org: params.orgName, when: params.deletedAtLabel });
  const support = params.supportEmail ?? null;
  return emailLayout({
    locale: params.locale,
    subject: m.subject({ org: params.orgName }),
    preheader: m.preheader({ org: params.orgName }),
    body: `
      ${heading(m.heading)}
      ${paragraph(intro, "0 0 16px 0")}
      ${paragraph(m.permanent, "0 0 16px 0")}
      ${paragraph(m.accountKept, "0 0 16px 0")}
      ${mutedHtml(support ? richHtml((s) => m.notYouWithSupport(s), { email: mailtoLink(support) }) : text(m.notYouWithoutSupport), "0")}
    `,
  });
}
