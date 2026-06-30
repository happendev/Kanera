import { provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { WireBoardMemberUser } from "@kanera/shared/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../core/api/api.client";
import { avatarColorIndex } from "../../shared/avatar.component";
import { DescriptionViewerComponent } from "./description-viewer.component";

describe("DescriptionViewerComponent mentions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(value: string, api?: Partial<ApiClient>, workspaceId?: string, mentionMembers: WireBoardMemberUser[] = []) {
    TestBed.configureTestingModule({
      imports: [DescriptionViewerComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiClient, useValue: api ?? { post: vi.fn(async () => ({ links: {} })) } },
      ],
    });
    const fixture = TestBed.createComponent(DescriptionViewerComponent);
    fixture.componentRef.setInput("value", value);
    fixture.componentRef.setInput("mentionMembers", mentionMembers);
    if (workspaceId !== undefined) fixture.componentRef.setInput("workspaceId", workspaceId);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return {
      el: fixture.nativeElement as HTMLElement,
      fixture,
    };
  }

  it("renders durable user mention markdown as a styled chip", async () => {
    const { el } = await render("Ping @[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000) today.");

    const mention = el.querySelector(".mention-chip") as HTMLElement | null;
    expect(mention?.querySelector("span:last-child")?.textContent).toBe("@Ada Lovelace");
    expect(mention?.dataset["userId"]).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("colors mention chips with the tagged user's avatar color bucket", async () => {
    const userId = "123e4567-e89b-12d3-a456-426614174000";
    const { el } = await render(`Ping @[Ada Lovelace](kanera-user:${userId}) today.`);

    const mention = el.querySelector(".mention-chip") as HTMLElement | null;
    const colorIndex = avatarColorIndex(userId, "Ada Lovelace");
    expect(mention?.getAttribute("style")).toContain(`--mention-avatar-bg: var(--avatar-color-${colorIndex}-bg)`);
    expect(mention?.getAttribute("style")).toContain(`--mention-avatar-fg: var(--avatar-color-${colorIndex}-fg)`);
    expect(mention?.querySelector(".mention-chip-avatar")).not.toBeNull();
  });

  it("shows a tiny profile image for mentioned users with avatars", async () => {
    const userId = "123e4567-e89b-12d3-a456-426614174000";
    const { el } = await render(
      `Ping @[Ada](kanera-user:${userId}) today.`,
      undefined,
      undefined,
      [{
        userId,
        displayName: "Ada Lovelace",
        avatarUrl: "/avatars/ada.png",
        role: "editor",
        source: "workspace",
      }],
    );

    const image = el.querySelector(".mention-chip-avatar img") as HTMLImageElement | null;
    expect(image?.getAttribute("src")).toBe("/avatars/ada.png");
    expect(el.querySelector(".mention-chip")?.textContent).toContain("@Ada");
  });

  it("leaves plain at-text unchanged", async () => {
    const { el } = await render("Ping @Ada today.");

    expect(el.querySelector(".mention-chip")).toBeNull();
    expect(el.textContent).toContain("@Ada");
  });

  it("renders Unicode emoji without sanitization loss", async () => {
    const { el } = await render("Ship it 👍 🎉");

    expect(el.textContent).toContain("👍");
    expect(el.textContent).toContain("🎉");
  });

  it("renders emoji mixed with mentions, links, and images", async () => {
    const { el } = await render("Nice 👍 @[Ada](kanera-user:123e4567-e89b-12d3-a456-426614174000) [docs](https://example.com) ![party](/party.png)");

    expect(el.textContent).toContain("👍");
    expect(el.querySelector(".mention-chip span:last-child")?.textContent).toBe("@Ada");
    expect((el.querySelector('a[href="https://example.com"]') as HTMLAnchorElement | null)?.textContent).toBe("docs");
    expect((el.querySelector("img") as HTMLImageElement | null)?.getAttribute("src")).toBe("/party.png");
  });

  it("renders pasted markdown as formatted content", async () => {
    const { el } = await render([
      "## Plan",
      "",
      "- [x] Draft",
      "- [ ] Review",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Owner | Ada |",
      "",
      "> Keep it tidy",
    ].join("\n"));

    expect(el.querySelector("h2")?.textContent).toBe("Plan");
    expect(el.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect((el.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked).toBe(true);
    expect(el.querySelector("table")?.textContent).toContain("Owner");
    expect(el.querySelector("blockquote")?.textContent).toContain("Keep it tidy");
    expect(el.textContent).not.toContain("| Field | Value |");
  });

  it("sanitizes markup around mention labels", async () => {
    const { el } = await render("@[<img src=x onerror=alert(1)>](kanera-user:123e4567-e89b-12d3-a456-426614174000)");

    const mention = el.querySelector(".mention-chip") as HTMLElement | null;
    expect(mention?.textContent).toContain("@<img src=x onerror=alert(1)>");
    expect(mention?.querySelector("img")).toBeNull();
  });

  it("renders a bare Kanera card URL as a pretty card link after resolution", async () => {
    const boardId = "123e4567-e89b-12d3-a456-426614174000";
    const cardId = "123e4567-e89b-12d3-a456-426614174001";
    const href = `/b/${boardId}/c/${cardId}`;
    const post = vi.fn(async () => ({
      links: {
        [href]: {
          kind: "card",
          title: "Prepare launch",
          boardName: "Launch",
          listName: "Todo",
          boardId,
          boardIcon: "rocket",
          boardIconColor: "blue",
          cardId,
          href,
        },
      },
    }));

    const { el } = await render(`See ${href}`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/internal-links/resolve", { urls: [href] });
    const chip = el.querySelector(".internal-link-chip.is-card") as HTMLAnchorElement | null;
    expect(chip?.getAttribute("href")).toBe(href);
    expect(chip?.getAttribute("style")).toContain("--color-blue");
    expect(chip?.querySelector("i")?.className).toContain("ti-rocket");
    expect(chip?.textContent).toContain("Prepare launch");
    expect(chip?.querySelector(".internal-link-hint")?.textContent).toBe("Launch - Todo");
  });

  it("renders a bare Kanera note URL as a pretty note link after resolution", async () => {
    const workspaceId = "123e4567-e89b-12d3-a456-426614174000";
    const noteId = "123e4567-e89b-12d3-a456-426614174002";
    const href = `/w/${workspaceId}/notes?noteId=${noteId}`;
    const post = vi.fn(async () => ({
      links: {
        [href]: {
          kind: "note",
          title: "Launch runbook",
          noteId,
          workspaceId,
          boardId: null,
          boardName: null,
          scope: "team",
          icon: "book",
          href,
        },
      },
    }));

    const { el } = await render(`See ${href}`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/internal-links/resolve", { urls: [href] });
    const chip = el.querySelector(".internal-link-chip.is-note") as HTMLAnchorElement | null;
    expect(chip?.getAttribute("href")).toBe(href);
    expect(chip?.querySelector("i")?.className).toContain("ti-book");
    expect(chip?.textContent).toContain("Launch runbook");
    expect(chip?.querySelector(".internal-link-hint")?.textContent).toBe("Team note");
  });

  it("renders board URLs with cardId query params as card links", async () => {
    const boardId = "123e4567-e89b-12d3-a456-426614174000";
    const cardId = "123e4567-e89b-12d3-a456-426614174001";
    const href = `/b/${boardId}?cardId=${cardId}`;
    const post = vi.fn(async () => ({
      links: {
        [href]: {
          kind: "card",
          title: "Query card",
          boardName: "Launch",
          listName: "Done",
          boardId,
          boardIcon: "briefcase",
          boardIconColor: "teal",
          cardId,
          href,
        },
      },
    }));

    const { el } = await render(`[card](${href})`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/internal-links/resolve", { urls: [href] });
    const chip = el.querySelector(".internal-link-chip.is-card") as HTMLAnchorElement | null;
    expect(chip?.getAttribute("href")).toBe(href);
    expect(chip?.querySelector("i")?.className).toContain("ti-briefcase");
    expect(chip?.getAttribute("style")).toContain("--color-teal");
    expect(chip?.textContent).toContain("Query card");
  });

  it("renders markdown Kanera card links with the resolved card title", async () => {
    const boardId = "123e4567-e89b-12d3-a456-426614174000";
    const cardId = "123e4567-e89b-12d3-a456-426614174001";
    const href = `/b/${boardId}/c/${cardId}`;
    const post = vi.fn(async () => ({
      links: {
        [href]: {
          kind: "card",
          title: "Resolved title",
          boardName: "Delivery",
          listName: "Backlog",
          boardId,
          boardIcon: null,
          boardIconColor: null,
          cardId,
          href,
        },
      },
    }));

    const { el } = await render(`[old label](${href})`, { post } as Partial<ApiClient>);

    const chip = el.querySelector(".internal-link-chip.is-card") as HTMLAnchorElement | null;
    expect(chip?.getAttribute("href")).toBe(href);
    expect(chip?.textContent).toContain("Resolved title");
    expect(chip?.textContent).not.toContain("old label");
  });

  it("renders a Kanera board URL as a pretty board link", async () => {
    const boardId = "123e4567-e89b-12d3-a456-426614174000";
    const href = `/b/${boardId}`;
    const post = vi.fn(async () => ({
      links: {
        [href]: {
          kind: "board",
          title: "Planning",
          boardId,
          icon: "calendar",
          iconColor: "purple",
          href,
        },
      },
    }));

    const { el } = await render(`[board](${href})`, { post } as Partial<ApiClient>);

    const chip = el.querySelector(".internal-link-chip.is-board") as HTMLAnchorElement | null;
    expect(chip?.getAttribute("href")).toBe(href);
    expect(chip?.querySelector("i")?.className).toContain("ti-calendar");
    expect(chip?.getAttribute("style")).toContain("--color-purple");
    expect(chip?.textContent).toContain("Planning");
    expect(chip?.textContent).toContain("Board");
  });

  it("leaves external links and unresolved internal links as normal anchors", async () => {
    const boardId = "123e4567-e89b-12d3-a456-426614174000";
    const href = `/b/${boardId}`;
    const post = vi.fn(async () => ({ links: {} }));

    const { el } = await render(`[external](https://example.com) [missing](${href})`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/internal-links/resolve", { urls: [href] });
    expect(el.querySelector(".internal-link-chip")).toBeNull();
    expect((el.querySelector('a[href="https://example.com"]') as HTMLAnchorElement | null)?.textContent).toBe("external");
    expect((el.querySelector(`a[href="${href}"]`) as HTMLAnchorElement | null)?.textContent).toBe("missing");
  });

  it("renders a bare GitHub pull request URL as a resolved GitHub card", async () => {
    const href = "https://github.com/acme/kanera/pull/42";
    const post = vi.fn(async (path: string) => {
      if (path === "/github-links/resolve") {
        return {
          links: {
            [href]: {
              kind: "pull",
              owner: "acme",
              repo: "kanera",
              fullName: "acme/kanera",
              number: 42,
              title: "Add private previews",
              state: "open",
              changedFiles: 7,
              additions: 936,
              deletions: 877,
              href,
            },
          },
        };
      }
      return { links: {} };
    });

    const { el } = await render(`See ${href}`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/github-links/resolve", { urls: [href], workspaceId: undefined });
    expect(post).not.toHaveBeenCalledWith("/internal-links/resolve", expect.objectContaining({ urls: [href] }));
    const card = el.querySelector(".github-link-card.is-pull") as HTMLAnchorElement | null;
    expect(card?.getAttribute("href")).toBe(href);
    expect(card?.querySelector(".github-link-brand-icon")?.className).toContain("ti-brand-github");
    expect(card?.querySelector(".github-link-card-meta i")?.className).toContain("ti-git-pull-request");
    expect(card?.textContent).toContain("PR #42: Add private previews");
    expect(card?.textContent).toContain("acme/kanera");
    expect(card?.textContent).toContain("open");
    expect(card?.textContent).toContain("Changed files");
    expect(card?.textContent).toContain("7");
    expect(card?.textContent).toContain("+936");
    expect(card?.textContent).toContain("-877");
  });

  it("renders a public GitHub repository URL as a resolved GitHub card", async () => {
    const href = "https://github.com/acme/kanera";
    const post = vi.fn(async (path: string) => {
      if (path === "/github-links/resolve") {
        return {
          links: {
            [href]: {
              kind: "repo",
              owner: "acme",
              repo: "kanera",
              fullName: "acme/kanera",
              title: "acme/kanera",
              description: "Project work, neatly arranged",
              private: false,
              href,
            },
          },
        };
      }
      return { links: {} };
    });

    const { el } = await render(`Repo ${href}`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/github-links/resolve", { urls: [href], workspaceId: undefined });
    const card = el.querySelector(".github-link-card.is-repo") as HTMLAnchorElement | null;
    expect(card?.getAttribute("href")).toBe(href);
    expect(card?.textContent).toContain("acme/kanera");
    expect(card?.textContent).toContain("Project work, neatly arranged");
  });

  it("renders a bare GitHub issue URL as a resolved GitHub card", async () => {
    const href = "https://github.com/EPPlusSoftware/EPPlus/issues/2392";
    const post = vi.fn(async (path: string) => {
      if (path === "/github-links/resolve") {
        return {
          links: {
            [href]: {
              kind: "issue",
              owner: "EPPlusSoftware",
              repo: "EPPlus",
              fullName: "EPPlusSoftware/EPPlus",
              number: 2392,
              title: "Support workbook metadata",
              state: "open",
              href,
            },
          },
        };
      }
      return { links: {} };
    });

    const { el } = await render(`Issue ${href}`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/github-links/resolve", { urls: [href], workspaceId: undefined });
    const card = el.querySelector(".github-link-card.is-issue") as HTMLAnchorElement | null;
    expect(card?.getAttribute("href")).toBe(href);
    expect(card?.querySelector(".github-link-card-meta i")?.className).toContain("ti-circle-dot");
    expect(card?.textContent).toContain("Issue #2392: Support workbook metadata");
    expect(card?.textContent).toContain("EPPlusSoftware/EPPlus");
    expect(card?.textContent).toContain("open");
  });

  it("renders a bare GitHub release tag URL as a resolved GitHub card", async () => {
    const href = "https://github.com/EPPlusSoftware/EPPlus/releases/tag/v8.6.1";
    const post = vi.fn(async (path: string) => {
      if (path === "/github-links/resolve") {
        return {
          links: {
            [href]: {
              kind: "release",
              owner: "EPPlusSoftware",
              repo: "EPPlus",
              fullName: "EPPlusSoftware/EPPlus",
              tagName: "v8.6.1",
              title: "EPPlus 8.6.1",
              state: "released",
              publishedAt: "2026-06-01T12:00:00Z",
              href,
            },
          },
        };
      }
      return { links: {} };
    });

    const { el } = await render(`Release ${href}`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/github-links/resolve", { urls: [href], workspaceId: undefined });
    const card = el.querySelector(".github-link-card.is-release") as HTMLAnchorElement | null;
    expect(card?.getAttribute("href")).toBe(href);
    expect(card?.querySelector(".github-link-card-meta i")?.className).toContain("ti-tag");
    expect(card?.textContent).toContain("v8.6.1: EPPlus 8.6.1");
    expect(card?.textContent).toContain("EPPlusSoftware/EPPlus");
    expect(card?.textContent).toContain("released");
  });

  it("does not swallow trailing punctuation into bare GitHub links", async () => {
    const repoHref = "https://github.com/acme/kanera";
    const issueHref = "https://github.com/acme/kanera/issues/7";
    const releaseHref = "https://github.com/acme/kanera/releases/tag/v8.6.1";
    const post = vi.fn(async (path: string) => {
      if (path === "/github-links/resolve") {
        return {
          links: {
            [repoHref]: {
              kind: "repo",
              owner: "acme",
              repo: "kanera",
              fullName: "acme/kanera",
              title: "acme/kanera",
              description: null,
              private: false,
              href: repoHref,
            },
            [issueHref]: {
              kind: "issue",
              owner: "acme",
              repo: "kanera",
              fullName: "acme/kanera",
              number: 7,
              title: "Trim punctuation",
              state: "closed",
              href: issueHref,
            },
            [releaseHref]: {
              kind: "release",
              owner: "acme",
              repo: "kanera",
              fullName: "acme/kanera",
              tagName: "v8.6.1",
              title: "v8.6.1",
              state: "released",
              publishedAt: null,
              href: releaseHref,
            },
          },
        };
      }
      return { links: {} };
    });

    const { el } = await render(`Repo ${repoHref}. Issue ${issueHref}, release ${releaseHref}.`, { post } as Partial<ApiClient>);

    expect(post).toHaveBeenCalledWith("/github-links/resolve", { urls: [repoHref, issueHref, releaseHref], workspaceId: undefined });
    const cards = Array.from(el.querySelectorAll<HTMLAnchorElement>(".github-link-card"));
    expect(cards.map((card) => card.getAttribute("href"))).toEqual([repoHref, issueHref, releaseHref]);
    expect(el.textContent).toContain(".");
    expect(el.textContent).toContain(",");
  });

  it("passes workspace context when resolving GitHub links", async () => {
    const href = "https://github.com/acme/kanera/commit/123e4567e89b12d3a456426614174000000000";
    const post = vi.fn(async () => ({
      links: {
        [href]: {
          kind: "commit",
          owner: "acme",
          repo: "kanera",
          fullName: "acme/kanera",
          sha: "123e4567e89b12d3a456426614174000000000",
          shortSha: "123e456",
          title: "Tighten resolver",
          changedFiles: null,
          additions: null,
          deletions: null,
          href,
        },
      },
    }));

    const { el } = await render(`[commit](${href})`, { post } as Partial<ApiClient>, "workspace-1");

    expect(post).toHaveBeenCalledWith("/github-links/resolve", { urls: [href], workspaceId: "workspace-1" });
    const card = el.querySelector(".github-link-card.is-commit") as HTMLAnchorElement | null;
    expect(card?.textContent).toContain("123e456: Tighten resolver");
  });

  it("leaves unsupported GitHub URLs as normal anchors", async () => {
    const href = "https://github.com/acme/kanera/actions/runs/7";
    const post = vi.fn(async () => ({ links: {} }));

    const { el } = await render(`[issue](${href})`, { post } as Partial<ApiClient>);

    expect(post).not.toHaveBeenCalledWith("/github-links/resolve", expect.anything());
    expect(el.querySelector(".github-link-card")).toBeNull();
    expect((el.querySelector(`a[href="${href}"]`) as HTMLAnchorElement | null)?.textContent).toBe("issue");
  });

  it("still emits image clicks after link decoration changes", async () => {
    const { el, fixture } = await render("![Example](/assets/example.png)");
    const emitted: string[] = [];
    fixture.componentInstance.imageClick.subscribe((src) => emitted.push(src));

    const img = el.querySelector("img") as HTMLImageElement;
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(emitted.length).toBe(1);
    expect(emitted[0]).toContain("/assets/example.png");
  });

  it("lets image clicks bubble when image handling is disabled", async () => {
    const { el, fixture } = await render("![Example](/assets/example.png)");
    fixture.componentRef.setInput("handleImageClicks", false);
    fixture.detectChanges();
    const emitted: string[] = [];
    const bubbled = vi.fn();
    fixture.componentInstance.imageClick.subscribe((src) => emitted.push(src));
    el.addEventListener("click", bubbled);

    const img = el.querySelector("img") as HTMLImageElement;
    img.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(emitted).toEqual([]);
    expect(bubbled).toHaveBeenCalledTimes(1);
  });

  it("downloads Kanera media links with their rendered attachment file name", async () => {
    const href = "https://api.test/api/media/client-1/cards/card-1/01901234-5678-7abc-8def-0123456789ab.docx?t=token&e=9999999999999";
    const { el } = await render(`[Project brief.docx](${href})`);

    const blob = new Blob(["doc"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, blob: () => Promise.resolve(blob) })));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:description-download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let anchor: HTMLAnchorElement | null = null;
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") anchor = element as HTMLAnchorElement;
      return element;
    });

    const mediaLink = el.querySelector("a") as HTMLAnchorElement;
    mediaLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(href));
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));

    const downloadAnchor = anchor as HTMLAnchorElement | null;
    expect(downloadAnchor?.href).toBe("blob:description-download");
    expect(downloadAnchor?.download).toBe("Project brief.docx");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:description-download");
  });

  it("renders Kanera media links as attachment chips with file type icons", async () => {
    const href = "/api/media/client-1/cards/card-1/01901234-5678-7abc-8def-0123456789ab.pdf?t=token&e=9999999999999";
    const { el } = await render(`[Signed contract.pdf](${href})`);

    const chip = el.querySelector(".attachment-link-chip") as HTMLAnchorElement | null;
    expect(chip?.getAttribute("href")).toBe(href);
    expect(chip?.querySelector("i")?.className).toContain("ti-file-type-pdf");
    expect(chip?.querySelector(".attachment-link-title")?.textContent).toBe("Signed contract.pdf");
  });

  it("does not intercept non-media links", async () => {
    const { el } = await render("[docs](https://example.com/docs)");
    vi.stubGlobal("fetch", vi.fn());

    const link = el.querySelector("a") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("copies rendered markdown as structured plain text", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { el, fixture } = await render([
      "## Plan",
      "",
      "- Parent",
      "  - Child",
      "- [x] Draft",
      "- [ ] Review",
      "",
      "1. First",
      "2. Second",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Owner | Ada |",
      "",
      "> Keep it tidy",
      "",
      "```ts",
      "const ready = true;",
      "```",
    ].join("\n"));
    fixture.componentRef.setInput("showCopy", true);
    fixture.detectChanges();

    const button = el.querySelector(".dv-copy-btn") as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith([
      "Plan",
      "",
      "- Parent",
      "    - Child",
      "- [x] Draft",
      "- [ ] Review",
      "",
      "1. First",
      "2. Second",
      "",
      "Field  Value",
      "Owner  Ada",
      "",
      "> Keep it tidy",
      "",
      "const ready = true;",
    ].join("\n"));
    expect(button.getAttribute("aria-label")).toBe("Copied text");
  });

  it("copies mentions and links as human-readable text", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { el, fixture } = await render("Ping @[Ada Lovelace](kanera-user:123e4567-e89b-12d3-a456-426614174000) via [docs](https://example.com/docs).");
    fixture.componentRef.setInput("showCopy", true);
    fixture.detectChanges();

    (el.querySelector(".dv-copy-btn") as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(writeText).toHaveBeenCalledWith("Ping @Ada Lovelace via docs.");
  });

  it("hides the copy button for empty rendered content", async () => {
    const { el, fixture } = await render("   ");
    fixture.componentRef.setInput("showCopy", true);
    fixture.detectChanges();

    expect(el.querySelector(".dv-copy-btn")).toBeNull();
  });
});
