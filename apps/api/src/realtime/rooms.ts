/**
 * Workspace metadata that every authorized board viewer already receives in board-open/catalog
 * responses, without admitting board-only guests to the full workspace event stream.
 */
export function boardVisibleWorkspaceRoom(workspaceId: string): string {
  return `workspace-board-metadata:${workspaceId}`;
}
