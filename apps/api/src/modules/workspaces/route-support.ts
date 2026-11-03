import type { Workspace } from "@kanera/shared/schema";

export function toWireWorkspace<T extends Workspace>(workspace: T): Omit<T, "lastCardNumber"> {
  const { lastCardNumber: _lastCardNumber, ...publicWorkspace } = workspace;
  return publicWorkspace;
}
