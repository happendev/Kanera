import { cardPath } from "@kanera/shared/card-links";

function cardDetailUrl(organisationKey: string, cardKey: string): string {
  return cardPath(organisationKey, cardKey);
}

export function openCardDetailInNewTab(organisationKey: string, cardKey: string): void {
  window.open(cardDetailUrl(organisationKey, cardKey), "_blank", "noopener");
}

/**
 * True for a click the app should route itself. Modified and non-primary clicks keep the browser's
 * own behaviour (new tab/window) on internal links, whose hrefs are real canonical URLs.
 */
export function isPlainPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
