import type { Locale } from "@kanera/shared/locales";
import type { StorageWarningEmailQueueData } from "@kanera/shared/schema";
import { serverMessages } from "../i18n/messages/index.js";
import { button, emailLayout, fallbackLink, heading, mutedHtml, paragraph, text } from "./layout.js";

/** Size labels are already formatted in `locale`. */
export type StorageWarningEmailParams = StorageWarningEmailQueueData & { locale: Locale };

/**
 * Sent once to owners and admins when a hosted organisation nears its storage quota, before uploads
 * start failing for everyone. Points at the storage cleanup tool first; upgrading is the second
 * option, and only for a Free organisation that would actually gain storage.
 */
export function storageWarningEmail(params: StorageWarningEmailParams): string {
  const m = serverMessages(params.locale).email.storageWarning;
  const subject = m.subject({ org: params.orgName });
  const upgradeLine = params.upgradeQuotaLabel ? m.upgrade({ quota: params.upgradeQuotaLabel }) : m.noUpgrade;
  const body = `
    ${heading(m.heading)}
    ${paragraph(m.intro({ firstName: firstName(params.displayName), org: params.orgName, used: params.usedLabel, quota: params.quotaLabel, percent: params.percentUsed }), "0 0 14px 0")}
    ${paragraph(m.whenFull, "0 0 14px 0")}
    ${paragraph(m.howToFree, "0 0 14px 0")}
    ${paragraph(upgradeLine)}
    ${button({ href: params.storageUrl, label: m.button })}
    ${fallbackLink(params.storageUrl, params.locale)}
    ${mutedHtml(text(m.footer), "18px 0 0 0")}
  `;
  return emailLayout({ locale: params.locale, subject, preheader: m.preheader({ percent: params.percentUsed, quota: params.quotaLabel }), body });
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] || displayName;
}
