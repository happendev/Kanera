import { SOURCE_LOCALE, type Locale } from "@kanera/shared/locales";
import { serverMessages } from "./i18n/messages/index.js";

/**
 * "Priya via Claude": the outbound (email/push) form of the in-app "via <agent>" chip, in the
 * reader's language. Callers without a recipient (the public inbox API) get the source wording.
 */
export function agentActorName(ownerName: string, agentName: string | null | undefined, locale: Locale = SOURCE_LOCALE): string {
  const common = serverMessages(locale).common;
  return common.viaAgent({ owner: ownerName, agent: agentName?.trim() || common.aiAgent });
}
