import { test as base, expect } from "./fixtures";

// Opt-in topology for cross-board scenarios. Every test gets an empty, API-created workspace;
// names describe fixture roles and have no relationship to the demo content.
export const test = base.extend<{ scenarioWorkspace: void }>({
  workspaceOptions: {
    boardName: "E2E primary board",
    lists: [{ name: "Backlog" }, { name: "Wishlist" }, { name: "In Progress", inProgress: true }, { name: "Ready for QA" }, { name: "Done" }],
  },
  scenarioWorkspace: [async ({ testWorkspace }, use) => {
    await testWorkspace.addBoard("E2E secondary board");
    await use();
  }, { auto: true }],
});

export { expect };
