export function cardDetailUrl(boardId: string, cardId: string): string {
  const params = new URLSearchParams({ cardId });
  return `/b/${encodeURIComponent(boardId)}?${params.toString()}`;
}

export function openCardDetailInNewTab(boardId: string, cardId: string): void {
  window.open(cardDetailUrl(boardId, cardId), "_blank", "noopener");
}
