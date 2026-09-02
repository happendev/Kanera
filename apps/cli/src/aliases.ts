import { usageError } from "./errors.js";

/**
 * Ergonomic command names for the tools people reach for constantly.
 *
 * This is a convenience layer, not the command surface: every tool remains reachable through
 * `kanera call <tool>`, and `kanera commands --json` catalogs all of them. Aliases exist so the
 * common path reads like a CLI ("kanera card done MKT-42") instead of an RPC call, and so a new
 * tool never has to be wired up here before it can be used.
 */
export interface CommandAlias {
  /** Command path, matched longest-first so `card done` wins over `card`. */
  path: string[];
  tool: string;
  summary: string;
  /** Positional arguments assigned, in order, to these tool arguments. */
  positionals?: string[];
  /** Arguments the alias fixes; explicit flags still win. */
  defaults?: Record<string, unknown>;
  group: string;
}

export const COMMAND_ALIASES: CommandAlias[] = [
  { path: ["whoami"], tool: "session.get", summary: "Show the credential, user, and scope in effect", group: "Account" },

  { path: ["workspaces"], tool: "workspaces.list", summary: "List accessible standard workspaces", group: "Discovery" },
  { path: ["boards"], tool: "boards.list_accessible", summary: "List every accessible board, including standalone and guest boards", group: "Discovery" },
  { path: ["board"], tool: "boards.get", summary: "Read a board with its lists, labels, fields, and members", positionals: ["boardId"], group: "Discovery" },
  { path: ["members"], tool: "workspaces.list_members", summary: "List a workspace's members", positionals: ["workspaceId"], group: "Discovery" },
  { path: ["search"], tool: "search.content", summary: "Search live cards, comments, notes, and attachments", positionals: ["query"], group: "Discovery" },
  { path: ["docs"], tool: "search.docs", summary: "Search the Kanera product documentation", positionals: ["query"], group: "Discovery" },

  { path: ["templates"], tool: "workspaces.list_templates", summary: "List workspace templates and what each one seeds", group: "Setup" },
  { path: ["workspace", "create"], tool: "workspaces.create", summary: "Create a standard workspace, optionally from --templateId", positionals: ["name"], group: "Setup" },
  { path: ["standalone", "create"], tool: "boards.create_standalone", summary: "Create a standalone board, optionally from --templateId", positionals: ["name"], group: "Setup" },
  { path: ["board", "create"], tool: "boards.create", summary: "Add a board to a standard workspace", positionals: ["workspaceId", "name"], group: "Setup" },

  { path: ["cards"], tool: "cards.list", summary: "List one page of cards from one workflow list", positionals: ["boardId", "listId"], group: "Cards" },
  { path: ["card"], tool: "cards.get", summary: "Read a card by id, key (MKT-42), or URL", positionals: ["cardId"], group: "Cards" },
  { path: ["card", "create"], tool: "cards.create", summary: "Create a card in a list", positionals: ["title"], group: "Cards" },
  { path: ["card", "update"], tool: "cards.update", summary: "Change card fields, for example --changes.title", positionals: ["cardId"], group: "Cards" },
  { path: ["card", "move"], tool: "cards.move", summary: "Move or reorder a card", positionals: ["cardId"], group: "Cards" },
  { path: ["card", "done"], tool: "cards.set_completion", summary: "Mark a card complete", positionals: ["cardId"], defaults: { completed: true }, group: "Cards" },
  { path: ["card", "reopen"], tool: "cards.set_completion", summary: "Mark a card incomplete", positionals: ["cardId"], defaults: { completed: false }, group: "Cards" },
  { path: ["card", "archive"], tool: "cards.archive", summary: "Archive a card", positionals: ["cardId"], group: "Cards" },
  { path: ["card", "history"], tool: "cards.list_history", summary: "List a card's activity and comments", positionals: ["cardId"], group: "Cards" },

  { path: ["comment"], tool: "comments.add", summary: "Comment on a card", positionals: ["cardId", "body"], group: "Discussion" },
  { path: ["comments"], tool: "comments.list", summary: "List a card's comments", positionals: ["cardId"], group: "Discussion" },
  { path: ["activity"], tool: "activity.list", summary: "List a board's recent activity", positionals: ["boardId"], group: "Discussion" },

  { path: ["work"], tool: "work.query_cards", summary: "List your work across every accessible board", defaults: { lens: "my" }, group: "Work" },
  { path: ["work", "history"], tool: "work.query_history", summary: "Report one person's actions over a date range", group: "Work" },
  { path: ["portfolio"], tool: "work.portfolio_summary", summary: "Roll up work by organisation, workspace, and board", group: "Work" },
  { path: ["priorities"], tool: "priorities.list", summary: "Read an \"Up next\" priority queue", group: "Work" },
  { path: ["priority", "add"], tool: "priorities.add", summary: "Add a card to an \"Up next\" queue", positionals: ["cardId"], group: "Work" },
  { path: ["priority", "move"], tool: "priorities.move", summary: "Reorder an \"Up next\" queue entry", positionals: ["priorityId"], group: "Work" },
  { path: ["priority", "remove"], tool: "priorities.remove", summary: "Remove an \"Up next\" queue entry", positionals: ["priorityId"], group: "Work" },

  { path: ["notes"], tool: "notes.list", summary: "List note metadata for a workspace or board", group: "Notes" },
  { path: ["note"], tool: "notes.get", summary: "Read a note", positionals: ["noteId"], group: "Notes" },
  { path: ["note", "create"], tool: "notes.create", summary: "Create a personal or team note", group: "Notes" },
];

export interface AliasMatch {
  alias: CommandAlias;
  /** Tokens left over after the command path, assigned to the alias positionals. */
  rest: string[];
}

export function matchAlias(positionals: string[]): AliasMatch | null {
  // Longest path first so a two-word alias is never shadowed by its one-word prefix.
  for (const length of [2, 1]) {
    if (positionals.length < length) continue;
    const candidate = positionals.slice(0, length);
    const alias = COMMAND_ALIASES.find(
      (entry) => entry.path.length === length && entry.path.every((part, index) => part === candidate[index]),
    );
    if (alias) return { alias, rest: positionals.slice(length) };
  }
  return null;
}

export function applyPositionals(alias: CommandAlias, rest: string[]): Record<string, unknown> {
  const assigned: Record<string, unknown> = { ...alias.defaults };
  const names = alias.positionals ?? [];
  if (rest.length > names.length) {
    const command = `kanera ${alias.path.join(" ")}`;
    throw usageError(
      `too many arguments for "${command}"`,
      `Expected: ${[command, ...names.map((name) => `<${name}>`)].join(" ")}`,
    );
  }
  rest.forEach((value, index) => {
    const name = names[index];
    if (name) assigned[name] = value;
  });
  return assigned;
}
