import type { StorageWarningEmailQueueData } from "@kanera/shared/schema";
import { button, emailLayout, fallbackLink, heading, mutedHtml, paragraph } from "./layout.js";

export type StorageWarningEmailParams = StorageWarningEmailQueueData;

/**
 * Sent once to owners and admins when a hosted organisation nears its storage quota, before uploads
 * start failing for everyone. Points at the storage cleanup tool first; upgrading is the second
 * option, and only for a Free organisation that would actually gain storage.
 */
export function storageWarningEmail(params: StorageWarningEmailParams): string {
  const subject = `${params.orgName} is running out of storage`;
  const upgradeLine = params.upgradeQuotaLabel
    ? `Upgrading to Kanera Pro raises the allowance to ${params.upgradeQuotaLabel}.`
    : "If you need more room than your plan includes, reply to this email and we'll help.";
  const body = `
    ${heading("You're close to your storage limit")}
    ${paragraph(`Hi ${firstName(params.displayName)}, ${params.orgName} has used ${params.usedLabel} of its ${params.quotaLabel} storage allowance (${params.percentUsed}%).`, "0 0 14px 0")}
    ${paragraph("When it's full, nobody in the organisation can upload attachments or paste images until space is freed.", "0 0 14px 0")}
    ${paragraph("You can free space yourself under Settings → Organisation → Storage. Its Clean up files list shows your organisation's largest and oldest files, including ones on archived cards that nobody sees anymore, and lets you filter them by size, age and workspace, then delete up to 100 at a time.", "0 0 14px 0")}
    ${paragraph(upgradeLine)}
    ${button({ href: params.storageUrl, label: "Clean up storage" })}
    ${fallbackLink(params.storageUrl)}
    ${mutedHtml("You're receiving this because you're an owner or admin of this organisation. We send it once each time usage approaches the limit.", "18px 0 0 0")}
  `;
  return emailLayout({ subject, preheader: `${params.percentUsed}% of ${params.quotaLabel} used. Free up space before uploads stop.`, body });
}

function firstName(displayName: string): string {
  return displayName.split(" ")[0] || displayName;
}
