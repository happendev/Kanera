// Original files (and service-worker content hashes) stay unchanged. nginx negotiates sidecars
// only for clients accepting gzip; browsers receive exactly the original decoded bytes.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "../dist/web/browser");
let count = 0;
for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:js|css|html|json|svg|webmanifest)$/u.test(entry.name)) continue;
  const path = join(entry.parentPath, entry.name);
  const original = await readFile(path);
  if (original.length < 1_024) continue;
  const compressed = gzipSync(original, { level: 9 });
  if (compressed.length >= original.length) continue;
  await writeFile(path + ".gz", compressed);
  count += 1;
}
console.log("Precompressed " + count + " static assets for nginx.");
