import { describe, expect, it } from "vitest";
import { findMatchingImportMember } from "./import-member-mapping.util";

const targets = [
  { userId: "user-1", displayName: " Ada Lovelace ", email: "ada@example.com" },
  { userId: "user-2", displayName: "Grace Hopper", email: "grace@example.com" },
  { userId: "user-3", displayName: "Linus Torvalds", email: "linus@kernel.example" },
  { userId: "user-4", displayName: "New Name", email: "renamed@example.com" },
];

describe("findMatchingImportMember", () => {
  it("matches source members by normalized display name", () => {
    expect(findMatchingImportMember({ fullName: "ada lovelace" }, targets)?.userId).toBe("user-1");
  });

  it("matches Trello usernames that are emails or email local parts", () => {
    expect(findMatchingImportMember({ fullName: "Someone Else", username: "grace@example.com" }, targets)?.userId).toBe("user-2");
    expect(findMatchingImportMember({ fullName: "Third Person", username: "linus" }, targets)?.userId).toBe("user-3");
  });

  it("matches Kanera exported email when the display name changed", () => {
    expect(findMatchingImportMember({ fullName: "Old Name", email: "renamed@example.com" }, targets)?.userId).toBe("user-4");
  });
});
