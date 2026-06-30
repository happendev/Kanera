import { execFileSync, spawn } from "node:child_process";

execFileSync(process.execPath, ["scripts/write-build-info.mjs"], { stdio: "inherit" });

const rawArgs = process.argv.slice(2);
const baseArgs = ["test", "--no-watch", "--no-progress"];

function includePattern(arg) {
  const normalized = arg.replaceAll("\\", "/").replace(/^apps\/web\//, "");
  return normalized.includes("/") ? normalized : `**/${normalized}`;
}

const passthrough = [];
const includes = [];

for (const arg of rawArgs) {
  if (arg.startsWith("-")) {
    passthrough.push(arg);
  } else {
    includes.push(includePattern(arg));
  }
}

const args = [
  ...baseArgs,
  ...includes.flatMap((pattern) => ["--include", pattern]),
  ...passthrough,
];

const child = spawn("ng", args, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
