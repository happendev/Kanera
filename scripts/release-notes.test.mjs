import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadReleaseNotes, parseReleaseNote, publishUnreleased, renderGitHubRelease } from "./release-notes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const note = (frontMatter, body) => `---\n${frontMatter}\n---\n\n${body}`;
const valid = note("version: 2.0.0\ndate: 2026-01-02\ntitle: Big things\nsummary: A summary.\nshipsWith: CLI 3.0.0, MCP 5.0.0", [
  "Lead with **bold**, `<code>` and [a link](https://example.com/a?b=1&c=2).",
  "",
  "## A highlight",
  "",
  '![Alt text](media/2.0.0/shot.jpg "compact")',
  "",
  "Highlight text.",
  "",
  "## New features",
  "",
  "- [Boards] A new board thing",
  "",
  "## Bug fixes",
  "",
  "- [Cards] A fixed card thing",
  "",
  "## Self-hosting",
  "",
  "- Set `FOO` before upgrading.",
].join("\n"));

test("every committed release note is valid", async () => {
  const { releases, errors } = await loadReleaseNotes(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(releases.length > 0);
});

test("parses a note into the shape the site renders", () => {
  const { release, errors } = parseReleaseNote(valid, { name: "2.0.0" });
  assert.deepEqual(errors, []);
  assert.equal(release.slug, "v2-0-0");
  assert.deepEqual(release.shipsWith, ["CLI 3.0.0", "MCP 5.0.0"]);
  assert.equal(release.lead[0].html, 'Lead with <strong>bold</strong>, <code>&lt;code&gt;</code> and <a href="https://example.com/a?b=1&amp;c=2">a link</a>.');
  assert.equal(release.lead[0].text, "Lead with bold, <code> and a link.");
  assert.deepEqual(release.highlights[0].blocks[0], { type: "image", src: "media/2.0.0/shot.jpg", alt: "Alt text", size: "compact" });
  assert.deepEqual(release.features, [{ area: "Boards", html: "A new board thing", text: "A new board thing" }]);
  assert.deepEqual(release.selfHosting, [{ html: "Set <code>FOO</code> before upgrading.", text: "Set FOO before upgrading." }]);
});

test("reports structural mistakes with line numbers", () => {
  const { errors } = parseReleaseNote(note("version: 2.0.0\ndate: 2026-01-02\ntitle: T\nsummary: S", [
    "## Bug fixes",
    "- Missing area",
    "- [Nowhere] Unknown area",
    "## New features",
    "- [Boards] Out of order",
    "## Late highlight",
    "Text",
    "### Nested",
    "![](media/9.9.9/x.png)",
  ].join("\n")), { name: "2.0.0" });
  const text = errors.join("\n");
  assert.match(text, /:9: "Bug fixes" items start with an \[Area\]/);
  assert.match(text, /:10: unknown area \[Nowhere\]/);
  assert.match(text, /:11: "New features" must come after "Bug fixes"/);
  assert.match(text, /:13: highlight "Late highlight" must come before the lists/);
  assert.match(text, /:15: only ## headings are supported/);
  assert.match(text, /:16: image needs alt text/);
  assert.match(text, /:16: screenshots for this release live in release-notes\/media\/2\.0\.0\//);
});

test("the unreleased draft must not carry a version", () => {
  const { errors } = parseReleaseNote(note("version: 2.0.0\ntitle: T\nsummary: S", "Lead.\n\n## Improvements\n\n- [Boards] Better"), { name: "unreleased" });
  assert.match(errors.join("\n"), /leave version and date out of unreleased\.md/);
});

test("renders the GitHub release with tag-pinned screenshots", () => {
  const { release } = parseReleaseNote(valid, { name: "2.0.0" });
  const markdown = renderGitHubRelease(release);
  assert.match(markdown, /^## Big things\n/);
  assert.match(markdown, /\[a link\]\(https:\/\/example\.com\/a\?b=1&c=2\)/);
  assert.match(markdown, /!\[Alt text\]\(https:\/\/raw\.githubusercontent\.com\/happendev\/Kanera\/v2\.0\.0\/release-notes\/media\/2\.0\.0\/shot\.jpg\)/);
  assert.match(markdown, /- \*\*Boards:\*\* A new board thing/);
  assert.match(markdown, /https:\/\/www\.kanera\.app\/changelog\/v2-0-0/);
});

test("publishUnreleased stamps, renames and moves screenshots", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kanera-release-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release-notes/media/unreleased"), { recursive: true });
  await writeFile(path.join(root, "release-notes/media/unreleased/shot.jpg"), "jpeg");
  await writeFile(path.join(root, "release-notes/unreleased.md"), note("title: T\nsummary: S", '![Alt](media/unreleased/shot.jpg "wide")\n\n## Improvements\n\n- [Boards] Better'));

  await publishUnreleased(root, "3.1.0", "2026-02-03");
  const { releases, unreleased, errors } = await loadReleaseNotes(root);
  assert.deepEqual(errors, []);
  assert.equal(unreleased, null);
  assert.equal(releases[0].version, "3.1.0");
  assert.equal(releases[0].date, "2026-02-03");
  assert.equal(releases[0].lead[0].src, "media/3.1.0/shot.jpg");
  assert.match(await readFile(path.join(root, "release-notes/3.1.0.md"), "utf8"), /^---\nversion: 3\.1\.0\ndate: 2026-02-03\ntitle: T/);
});
