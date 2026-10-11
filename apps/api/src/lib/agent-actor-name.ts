/** "Priya via Claude": the outbound (email/push) form of the in-app "via <agent>" chip. */
export function agentActorName(ownerName: string, agentName: string | null | undefined): string {
  return `${ownerName} via ${agentName?.trim() || "AI agent"}`;
}
