import { cardPath } from "@kanera/shared/card-links";

export function cardDetailUrl(organisationKey: string, cardKey: string): string {
  return cardPath(organisationKey, cardKey);
}

export function openCardDetailInNewTab(organisationKey: string, cardKey: string): void {
  window.open(cardDetailUrl(organisationKey, cardKey), "_blank", "noopener");
}
