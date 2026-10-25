import { globSync } from "node:fs";
import { basename, sep } from "node:path";
import timings from "../timings.json";

/** Keep whole files together, assigning the slowest remaining file to the lightest stack. */
export function balancedFiles(directory: string, shard: string): string[] {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw new Error("KANERA_E2E_SHARD must be index/total, for example 1/3");
  const index = Number(match[1]);
  const total = Number(match[2]);
  const files = globSync("**/*.spec.ts", { cwd: directory, exclude: ["artifacts/**", "node_modules/**"] })
    .filter((file) => !basename(file).startsWith("seed-"))
    .map((file) => file.split(sep).join("/"));
  if (index > total || total > files.length) throw new Error("E2E shard index/total would leave a missing or empty shard");
  const weights: Record<string, number> = timings.files;
  const known = Object.values(weights);
  // Newly added specs are always discovered, even before a timing refresh. Use the mean recorded
  // file cost until measured; stale entries for deleted files never select a nonexistent test.
  const fallback = known.reduce((sum, value) => sum + value, 0) / known.length;
  const weight = (file: string) => weights[file] ?? fallback;
  files.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const buckets = Array.from({ length: total }, () => ({ duration: 0, files: [] as string[] }));
  for (const file of files) {
    const lightest = buckets.reduce((a, b) => a.duration <= b.duration ? a : b);
    lightest.files.push(file);
    lightest.duration += weight(file);
  }
  const selected = buckets[index - 1]!;
  console.log(`E2E shard ${shard}: ${selected.files.length} behavior files, estimated ${Math.round(selected.duration / 1000)}s plus seed/startup`);
  return selected.files.map((file) => `**/${file}`);
}
