import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const integrationArg = args.find((arg) => arg.includes(".itest."));

if (integrationArg) {
  console.error(`Integration test file passed to the unit-test runner: ${integrationArg}`);
  console.error("Use: pnpm test:api:integration -- apps/api/src/path/to/file.itest.ts");
  process.exit(1);
}

const child = spawn("tsx", ["--import", "./src/test/setup.ts", "--test", "src/**/*.test.ts", ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
