import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { config } from "dotenv";

function findEnvFile(startDir = process.cwd()) {
  let dir = startDir;
  const { root } = parse(dir);

  while (true) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

config({ path: findEnvFile(), quiet: true });
