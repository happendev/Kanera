#!/usr/bin/env node
// Fails lint on leading-edge accent stripes in web styles (.scss, .css and inline `styles` in .ts).
// Kanera never highlights a card, row or banner with a coloured left edge; emphasis is a full ring,
// a background wash, weight or a badge. A 1px neutral divider between panels is not a stripe.
//
// Flagged:
//   border-left / border-inline-start (or -width) of 2px or more
//   border-left / border-inline-start (or -color) of any width in an accent or status colour
//   box-shadow: inset <x> 0 ... with a positive x (the painted-on stripe)
// A line, or the line above it, containing `accent-stripe-ok` with a reason is allowed.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(webRoot, "src");
const ALLOW = "accent-stripe-ok";

const EDGE = /\bborder-(?:left|inline-start)(-width|-color)?\s*:\s*([^;{}]+)/g;
const INSET_STRIPE = /\binset\s+(?:\d*\.)?\d+(?:px|rem|em)\s+0(?:px)?(?:\s+0(?:px)?)?\s+(?![\d.-])/;
const ACCENT_COLOUR = /--(?:accent|danger|success|warning|info|color-)|#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

function widthPx(value) {
  const match = /(?:^|\s)((?:\d*\.)?\d+)(px|rem|em)?(?=\s|$)/.exec(value.trim());
  if (!match) return null;
  return match[2] === "rem" || match[2] === "em" ? Number(match[1]) * 16 : Number(match[1]);
}

function problemsIn(line) {
  const problems = [];
  for (const [, part, value] of line.matchAll(EDGE)) {
    if (part === "-color") {
      if (ACCENT_COLOUR.test(value)) problems.push("accent-coloured leading border");
      continue;
    }
    const width = widthPx(value);
    if (width !== null && width >= 2) problems.push(`${width}px leading border`);
    else if (part !== "-width" && width !== null && width > 0 && ACCENT_COLOUR.test(value)) {
      problems.push("accent-coloured leading border");
    }
  }
  const shadow = /\bbox-shadow\s*:\s*([^;{}]+)/.exec(line);
  if (shadow && shadow[1].split(",").some((layer) => INSET_STRIPE.test(`${layer.trim()} `))) {
    problems.push("inset box-shadow stripe");
  }
  return problems;
}

function* styleFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* styleFiles(path);
    else if (/\.(scss|css|ts)$/.test(entry.name) && !entry.name.includes(".generated.") && !entry.name.endsWith(".spec.ts")) {
      yield path;
    }
  }
}

const failures = [];
for (const file of styleFiles(srcRoot)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.includes(ALLOW) || lines[index - 1]?.includes(ALLOW)) return;
    for (const problem of problemsIn(line)) {
      failures.push(`${relative(webRoot, file)}:${index + 1}  ${problem}: ${line.trim()}`);
    }
  });
}

if (failures.length > 0) {
  console.error(
    `Leading-edge accent stripes are not part of Kanera's design language. Use a full ring, a ` +
      `background wash, weight or a badge instead, or mark a deliberate exception with a ` +
      `\`${ALLOW}: <reason>\` comment.\n\n${failures.join("\n")}`,
  );
  process.exit(1);
}
