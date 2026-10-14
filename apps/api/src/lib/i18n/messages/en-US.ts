import enGB from "./en-GB.js";
import type { ServerMessages } from "./types.js";

/**
 * US English: the UK source catalog with only US spellings (organization, gotten, …) overridden.
 * Keep the same words and tone as en-GB; add an override here only when the US spelling differs.
 */

const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;

const { email } = enGB;
const { billing, lifecycle } = email;

const enUS: ServerMessages = {
  ...enGB,

  layout: {
    ...enGB.layout,
    footerLifecycle: "You're receiving this onboarding and account tip because you own a Kanera organization.",
  },

  email: {
    ...email,
    weeklyAdminRecap: {
      ...email.weeklyAdminRecap,
      metrics: {
        ...email.weeklyAdminRecap.metrics,
        newOrganisations: "New organizations",
        activeOrganisations: "Active organizations",
        paidOrganisations: "Paid organizations",
      },
      groupSummary: ({ seatCount, organisationCount }) =>
        `${plural(seatCount, "seat", "seats")} across ${plural(organisationCount, "organization", "organizations")}`,
      footnote: "Reporting windows and send time use UTC. Counts exclude soft-deleted accounts, organizations, and boards where applicable.",
    },
    inviteAccepted: {
      ...email.inviteAccepted,
      org: {
        ...email.inviteAccepted.org,
        role: ({ role }) => `Organization role: ${role}`,
      },
    },
    billing: {
      ...billing,
      trialWarning: {
        ...billing.trialWarning,
        lines: billing.trialWarning.lines.map((line) => line.replace("the organisation", "the organization")),
      },
      seatBilled: {
        ...billing.seatBilled,
        preheader: ({ seatKind }) => `A new ${seatKind} was billed for your organization.`,
      },
    },
    storageWarning: {
      ...email.storageWarning,
      whenFull: "When it's full, nobody in the organization can upload attachments or paste images until space is freed.",
      howToFree: "You can free space yourself under Settings → Organization → Storage. Its Clean up files list shows your organization's largest and oldest files, including ones on archived cards that nobody sees anymore, and lets you filter them by size, age and workspace, then delete up to 100 at a time.",
      footer: "You're receiving this because you're an owner or admin of this organization. We send it once each time usage approaches the limit.",
    },
    lifecycle: {
      ...lifecycle,
      inviteTeam: {
        ...lifecycle.inviteTeam,
        lines: lifecycle.inviteTeam.lines.map((line) => line.replace("whole organisation", "whole organization")),
      },
      inactive: {
        ...lifecycle.inactive,
        preheader: "No one in your organization has used Kanera for a couple of weeks. We'd like to know why.",
        title: "Has something gotten in the way?",
        wrongTool: {
          ...lifecycle.inactive.wrongTool,
          body: "That's fine. You can export any board from its menu, or delete your organization from organization settings.",
        },
      },
    },
    smtpTest: {
      ...email.smtpTest,
      intro: ({ email: to, sentAt }) =>
        `This is a test email from Kanera sent to ${to} on ${sentAt}. If it landed in your inbox, your organization's outgoing mail is configured correctly.`,
    },
  },
};

export default enUS;
