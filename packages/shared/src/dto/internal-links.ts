import { z } from "zod";

export const resolveInternalLinksBody = z.object({
  urls: z.array(z.string().min(1).max(2048)).max(50),
});
export type ResolveInternalLinksBody = z.infer<typeof resolveInternalLinksBody>;

export type ResolvedInternalLink =
  | {
      kind: "card";
      title: string;
      boardName: string;
      listName: string;
      boardId: string;
      boardIcon: string | null;
      boardIconColor: string | null;
      cardId: string;
      href: string;
    }
  | {
      kind: "board";
      title: string;
      boardId: string;
      icon: string | null;
      iconColor: string | null;
      href: string;
    }
  | {
      kind: "note";
      title: string;
      noteId: string;
      workspaceId: string;
      boardId: string | null;
      boardName: string | null;
      scope: "personal" | "team";
      icon: string | null;
      // palette token used to tint the note's icon in rendered link chips
      color: string | null;
      href: string;
    };

export interface ResolveInternalLinksResponse {
  links: Record<string, ResolvedInternalLink>;
}

export type LinkedNoteSummary = {
  kind: "note";
  id: string;
  title: string;
  workspaceId: string;
  boardId: string | null;
  boardName: string | null;
  scope: "personal" | "team";
  icon: string | null;
  color: string | null;
};

export type LinkedCardSummary = {
  kind: "card";
  id: string;
  title: string;
  boardId: string;
  boardName: string;
  listName: string;
  icon: string | null;
  iconColor: string | null;
};

export type LinkedInternalSummary = LinkedNoteSummary | LinkedCardSummary;

export type BacklinkSummary =
  | {
      kind: "card";
      id: string;
      title: string;
      boardId: string;
      boardName: string;
      listName: string;
      icon: string | null;
      iconColor: string | null;
    }
  | {
      kind: "board";
      id: string;
      title: string;
      boardId: string;
      icon: string | null;
      iconColor: string | null;
    }
  | {
      kind: "note";
      id: string;
      title: string;
      workspaceId: string;
      boardId: string | null;
      boardName: string | null;
      scope: "personal" | "team";
      icon: string | null;
      color: string | null;
    };

export interface NoteBacklinksResponse {
  backlinks: BacklinkSummary[];
}
