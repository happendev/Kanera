#!/usr/bin/env node
// Parses, validates and publishes the per-release notes in release-notes/ (format in
// release-notes/README.md). Kanera-site imports loadReleaseNotes() from this file to build its
// public changelog, so the parsed shape is a contract: add fields, but do not rename or remove them
// without updating Kanera-site's scripts/sync-release-notes.mjs.
//
//   node scripts/release-notes.mjs check               validate every note and its screenshots
//   node scripts/release-notes.mjs github <version>    print the GitHub release description

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const NOTES_DIR = "release-notes";
export const UNRELEASED = "unreleased";
export const REPOSITORY_URL = "https://github.com/happendev/Kanera";
export const CHANGELOG_URL = "https://www.kanera.app/changelog";

export const AREAS = [
  "Boards", "Cards", "Table", "Calendar", "Timeline", "Dependencies", "My Cards", "Team Cards", "Home",
  "Up next", "Work done", "Notifications", "Comments", "Notes", "Scratchpad", "Automations", "Reporting",
  "Import", "Integrations", "AI agents", "MCP", "CLI", "SDK", "API", "Organisations", "Members", "Guests",
  "Security", "Settings", "Billing", "Self-hosting", "Mobile", "Offline", "Performance", "Languages",
  "Appearance", "Onboarding", "Editor",
];

// Reserved headings, in the order they must appear after the highlights.
const LISTS = [
  { heading: "New features", key: "features", area: true },
  { heading: "Improvements", key: "improvements", area: true },
  { heading: "Bug fixes", key: "fixes", area: true },
  { heading: "Self-hosting", key: "selfHosting", area: false },
];
const IMAGE_SIZES = ["wide", "medium", "compact"];
const FRONT_MATTER_KEYS = ["version", "date", "title", "summary", "shipsWith"];
const SUMMARY_MAX = 200;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const escapeHtml = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Splits inline Markdown into code spans and text, so formatting never applies inside code. */
function inlineTokens(source) {
  return source.split(/(`[^`]+`)/).filter(Boolean).map((part) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? { code: part.slice(1, -1) } : { text: part });
}

const linkPattern = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;

export function inlineToHtml(source) {
  return inlineTokens(source).map((token) => {
    if (token.code !== undefined) return `<code>${escapeHtml(token.code)}</code>`;
    return escapeHtml(token.text)
      .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_match, label, href) => `<a href="${href}">${label}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }).join("");
}

export function inlineToText(source) {
  return inlineTokens(source).map((token) =>
    token.code ?? token.text.replace(linkPattern, "$1").replace(/\*\*([^*]+)\*\*/g, "$1")).join("");
}

function inlineErrors(source) {
  const errors = [];
  const text = inlineTokens(source).filter((token) => token.text !== undefined).map((token) => token.text).join("");
  const stripped = text.replace(linkPattern, "").replace(/\*\*([^*]+)\*\*/g, "$1");
  if (/\]\(/.test(stripped)) errors.push("links must be absolute https:// URLs");
  if (/\*/.test(stripped)) errors.push("only **bold** emphasis is supported");
  if (/<[a-z/!]/i.test(stripped)) errors.push("HTML is not supported");
  return errors;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pa[index] - pb[index];
  }
  return 0;
}

export function releaseSlug(version) {
  return `v${version.replace(/\./g, "-")}`;
}

function parseFrontMatter(source, report) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    report(1, "missing front matter (--- block with title and summary)");
    return { data: {}, body: source, bodyLine: 1 };
  }
  const data = {};
  match[1].split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const pair = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!pair) return report(index + 2, `front matter lines must be "key: value"`);
    const [, key, raw] = pair;
    if (!FRONT_MATTER_KEYS.includes(key)) return report(index + 2, `unknown front matter key "${key}"`);
    data[key] = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  });
  return { data, body: source.slice(match[0].length), bodyLine: match[0].split("\n").length };
}

/**
 * Parses one note. `name` is the file's version (or "unreleased"); `root` is the repository root,
 * used to check that referenced screenshots exist. Never throws on content: problems are returned
 * in `errors` as "file:line: message" strings.
 */
export function parseReleaseNote(source, { name, file = `${NOTES_DIR}/${name}.md`, root } = {}) {
  const errors = [];
  const report = (line, message) => errors.push(`${file}:${line}: ${message}`);
  const { data, body, bodyLine } = parseFrontMatter(source.replace(/\r\n/g, "\n"), report);
  const unreleased = name === UNRELEASED;

  if (!data.title) report(1, "front matter needs a title");
  if (!data.summary) report(1, "front matter needs a summary");
  else if (data.summary.length > SUMMARY_MAX) report(1, `summary is ${data.summary.length} characters; keep it to ${SUMMARY_MAX}`);
  if (unreleased) {
    if (data.version || data.date) report(1, "leave version and date out of unreleased.md; pnpm release writes them");
  } else {
    if (data.version !== name) report(1, `front matter version must be ${name}, matching the file name`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date ?? "") || Number.isNaN(Date.parse(data.date))) report(1, "front matter needs a date as YYYY-MM-DD");
  }

  const release = {
    version: unreleased ? null : name,
    slug: unreleased ? UNRELEASED : releaseSlug(name),
    date: data.date ?? null,
    title: data.title ?? "",
    summary: data.summary ?? "",
    shipsWith: data.shipsWith ? data.shipsWith.split(",").map((item) => item.trim()).filter(Boolean) : [],
    lead: [],
    highlights: [],
    features: [],
    improvements: [],
    fixes: [],
    selfHosting: [],
    images: [],
  };

  // Current section: the lead, a highlight, or one of the reserved lists.
  let section = { kind: "lead", blocks: release.lead };
  let listIndex = -1;
  let paragraph = [];
  let paragraphLine = 0;

  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (section.kind === "list") return report(paragraphLine, `"${LISTS[listIndex].heading}" may only contain "- " list items`);
    for (const message of inlineErrors(text)) report(paragraphLine, message);
    section.blocks.push({ type: "paragraph", html: inlineToHtml(text), text: inlineToText(text) });
  };

  body.split("\n").forEach((rawLine, index) => {
    const lineNumber = bodyLine + index;
    const line = rawLine.trimEnd();

    if (!line.trim()) return flush();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      if (heading[1] !== "##") return report(lineNumber, "only ## headings are supported; the release title belongs in front matter");
      const title = heading[2].trim();
      const reserved = LISTS.findIndex((list) => list.heading.toLowerCase() === title.toLowerCase());
      if (reserved >= 0) {
        if (reserved <= listIndex) report(lineNumber, `"${LISTS[reserved].heading}" must come after "${LISTS[listIndex].heading}" and only once`);
        listIndex = Math.max(listIndex, reserved);
        section = { kind: "list", list: LISTS[reserved] };
        return;
      }
      if (listIndex >= 0) report(lineNumber, `highlight "${title}" must come before the lists`);
      for (const message of inlineErrors(title)) report(lineNumber, message);
      const highlight = { title: inlineToText(title), blocks: [] };
      release.highlights.push(highlight);
      section = { kind: "highlight", blocks: highlight.blocks };
      return;
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
    if (image) {
      flush();
      if (section.kind === "list") return report(lineNumber, "images belong under the lead or a highlight, not in a list");
      const [, alt, src, size = "medium"] = image;
      const folder = `media/${name}/`;
      if (!alt.trim()) report(lineNumber, "image needs alt text describing what it shows");
      if (!IMAGE_SIZES.includes(size)) report(lineNumber, `image size must be one of ${IMAGE_SIZES.join(", ")}`);
      if (!src.startsWith(folder) || src.includes("..")) report(lineNumber, `screenshots for this release live in ${NOTES_DIR}/${folder}`);
      else if (!/\.(jpe?g|png|webp)$/i.test(src)) report(lineNumber, "screenshots must be JPEG, PNG or WebP");
      else if (root && !existsSync(path.join(root, NOTES_DIR, src))) report(lineNumber, `missing screenshot ${NOTES_DIR}/${src}`);
      section.blocks.push({ type: "image", src, alt: alt.trim(), size });
      release.images.push(src);
      return;
    }

    const item = line.match(/^[-*]\s+(.*)$/);
    if (item) {
      flush();
      if (section.kind !== "list") return report(lineNumber, "list items belong under New features, Improvements, Bug fixes or Self-hosting");
      let text = item[1].trim();
      let area = null;
      if (section.list.area) {
        const tagged = text.match(/^\[([^\]]+)\]\s+(.+)$/);
        if (!tagged) return report(lineNumber, `"${section.list.heading}" items start with an [Area]`);
        [, area, text] = tagged;
        if (!AREAS.includes(area)) report(lineNumber, `unknown area [${area}]; use one of: ${AREAS.join(", ")}`);
      }
      for (const message of inlineErrors(text)) report(lineNumber, message);
      release[section.list.key].push({ ...(area ? { area } : {}), html: inlineToHtml(text), text: inlineToText(text) });
      return;
    }

    if (/^(\s+[-*]|\d+\.|>|```|\|)/.test(line)) return report(lineNumber, "unsupported Markdown; use paragraphs, images, ## headings and one-line - items");
    if (!paragraph.length) paragraphLine = lineNumber;
    paragraph.push(line.trim());
  });
  flush();

  if (!release.lead.length && !release.highlights.length) report(1, "a note needs a lead paragraph or at least one highlight");
  for (const highlight of release.highlights) {
    if (!highlight.blocks.some((block) => block.type === "paragraph")) report(1, `highlight "${highlight.title}" has no text`);
  }
  if (!release.features.length && !release.improvements.length && !release.fixes.length && !release.selfHosting.length) {
    report(1, "a note needs at least one list item");
  }

  return { release, errors };
}

/**
 * Loads every note under `root/release-notes`. Published releases are sorted newest first.
 * `unreleased` is the parsed draft, or null when there is none.
 */
export async function loadReleaseNotes(root) {
  const dir = path.join(root, NOTES_DIR);
  const errors = [];
  const releases = [];
  let unreleased = null;
  for (const entry of (await readdir(dir)).sort()) {
    if (!entry.endsWith(".md") || entry === "README.md") continue;
    const name = entry.slice(0, -3);
    const file = `${NOTES_DIR}/${entry}`;
    if (name !== UNRELEASED && !semverPattern.test(name)) {
      errors.push(`${file}: name release notes <version>.md, such as 1.12.0.md, or unreleased.md`);
      continue;
    }
    const parsed = parseReleaseNote(await readFile(path.join(dir, entry), "utf8"), { name, file, root });
    errors.push(...parsed.errors);
    if (name === UNRELEASED) unreleased = parsed.release;
    else releases.push(parsed.release);
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));

  // Screenshots nobody references are probably a typo; flag them rather than shipping dead weight.
  const mediaDir = path.join(dir, "media");
  if (existsSync(mediaDir)) {
    const used = new Set([...releases, ...(unreleased ? [unreleased] : [])].flatMap((release) => release.images));
    for (const folder of await readdir(mediaDir)) {
      for (const media of await readdir(path.join(mediaDir, folder))) {
        if (!used.has(`media/${folder}/${media}`)) errors.push(`${NOTES_DIR}/media/${folder}/${media}: not used by any release note`);
      }
    }
  }
  return { releases, unreleased, errors };
}

function blocksToMarkdown(blocks, { mediaBase }) {
  return blocks.map((block) => block.type === "image"
    ? `![${block.alt}](${mediaBase}/${block.src})`
    : htmlToMarkdown(block.html)).join("\n\n");
}

// The stored HTML comes from the restricted inline syntax above, so reversing it is exact.
function htmlToMarkdown(html) {
  return html
    .replace(/<code>([^<]*)<\/code>/g, "`$1`")
    .replace(/<strong>([^<]*)<\/strong>/g, "**$1**")
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "[$2]($1)")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** The GitHub release description: the same story as the site, with screenshots from the tag. */
export function renderGitHubRelease(release) {
  const tag = `v${release.version}`;
  const mediaBase = `https://raw.githubusercontent.com/happendev/Kanera/${tag}/${NOTES_DIR}`;
  const parts = [`## ${release.title}`];
  if (release.lead.length) parts.push(blocksToMarkdown(release.lead, { mediaBase }));
  for (const highlight of release.highlights) {
    parts.push(`### ${highlight.title}`, blocksToMarkdown(highlight.blocks, { mediaBase }));
  }
  for (const list of LISTS) {
    const items = release[list.key];
    if (!items.length) continue;
    parts.push(`### ${list.heading}`, items.map((item) =>
      `- ${item.area ? `**${item.area}:** ` : ""}${htmlToMarkdown(item.html)}`).join("\n"));
  }
  if (release.shipsWith.length) parts.push(`Ships alongside ${release.shipsWith.join(" and ")}.`);
  parts.push(`[Read on the Kanera changelog](${CHANGELOG_URL}/${release.slug}) · [Full technical changelog](${REPOSITORY_URL}/blob/${tag}/CHANGELOG.md)`);
  return `${parts.join("\n\n")}\n`;
}

/**
 * Turns unreleased.md into <version>.md: writes version and date into the front matter, moves
 * media/unreleased/ to media/<version>/ and rewrites the image paths. Returns the paths it touched
 * (relative to root) so the caller can stage them. The caller validates the draft first.
 */
export async function publishUnreleased(root, version, date) {
  const dir = path.join(root, NOTES_DIR);
  const draftPath = path.join(dir, `${UNRELEASED}.md`);
  const targetPath = path.join(dir, `${version}.md`);
  if (existsSync(targetPath)) throw new Error(`${NOTES_DIR}/${version}.md already exists.`);

  const source = await readFile(draftPath, "utf8");
  const stamped = source
    .replace(/^---\r?\n/, `---\nversion: ${version}\ndate: ${date}\n`)
    .replaceAll(`](media/${UNRELEASED}/`, `](media/${version}/`);
  await writeFile(targetPath, stamped);
  await rm(draftPath);

  const touched = [`${NOTES_DIR}/${UNRELEASED}.md`, `${NOTES_DIR}/${version}.md`];
  const draftMedia = path.join(dir, "media", UNRELEASED);
  if (existsSync(draftMedia)) {
    await mkdir(path.join(dir, "media"), { recursive: true });
    await rename(draftMedia, path.join(dir, "media", version));
    touched.push(`${NOTES_DIR}/media`);
  }
  return touched;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [command, version] = process.argv.slice(2);
  const { releases, unreleased, errors } = await loadReleaseNotes(root);

  if (command === "check") {
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log(`${releases.length} release notes${unreleased ? " and the unreleased draft" : ""} are valid.`);
    return;
  }

  if (command === "github") {
    const release = releases.find((item) => item.version === version?.replace(/^v/, ""));
    if (!release) throw new Error(`No ${NOTES_DIR}/${version}.md. Usage: release-notes.mjs github <version>`);
    const own = errors.filter((error) => error.startsWith(`${NOTES_DIR}/${release.version}.md`));
    if (own.length) throw new Error(own.join("\n"));
    process.stdout.write(renderGitHubRelease(release));
    return;
  }

  throw new Error("Usage: release-notes.mjs check | github <version>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
