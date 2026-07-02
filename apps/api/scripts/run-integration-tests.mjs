import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import process from "node:process";
import pg from "pg";

const DEFAULT_CONCURRENCY = 4;
const requestedConcurrency = process.env.KANERA_TEST_CONCURRENCY ?? String(DEFAULT_CONCURRENCY);
const concurrency = Number(requestedConcurrency);

if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 15) {
  console.error("KANERA_TEST_CONCURRENCY must be an integer between 1 and 15");
  process.exit(1);
}

const requestedFiles = (process.env.KANERA_TEST_FILES ?? "src/**/*.itest.ts").split("\n").filter(Boolean);
const files = [];
for (const pattern of requestedFiles) {
  if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
    for await (const file of glob(pattern)) files.push(file);
  } else {
    files.push(pattern);
  }
}

const uniqueFiles = [...new Set(files)].sort();
if (uniqueFiles.length === 0) {
  console.error(`No integration test files matched: ${requestedFiles.join(", ")}`);
  process.exit(1);
}

const workerCount = Math.min(concurrency, uniqueFiles.length);
const baseUrl = new URL(process.env.DATABASE_URL ?? "postgres://kanera_test:kanera_test@localhost:55433/kanera_test");
const templateDatabase = baseUrl.pathname.slice(1);
const runId = `${process.pid}`;
const databases = Array.from({ length: workerCount }, (_, index) => `kanera_test_${runId}_${index + 1}`);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const children = new Set();
let adminConnected = false;
let interruptedSignal;

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function dropDatabases() {
  for (const database of databases) {
    await admin.query(`drop database if exists ${quoteIdentifier(database)} with (force)`);
  }
}

function runWorker(index, workerFiles) {
  const databaseUrl = new URL(baseUrl);
  databaseUrl.pathname = `/${databases[index]}`;
  const workerId = `${runId}-${index + 1}`;
  return new Promise((resolve) => {
    const child = spawn(
      "tsx",
      ["--import", "./src/test/setup.integration.ts", "--test", "--test-concurrency=1", ...workerFiles],
      {
        stdio: "inherit",
        shell: process.platform === "win32",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl.toString(),
          KANERA_TEST_WORKER_ID: workerId,
          UPLOADS_DIR: `.tmp/test-uploads-${workerId}`,
        },
      },
    );
    children.add(child);
    child.on("exit", (code, signal) => {
      children.delete(child);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interruptedSignal = signal;
    for (const child of children) child.kill(signal);
  });
}

let exitCode = 1;
try {
  await admin.connect();
  adminConnected = true;
  await dropDatabases();
  // Clone the migrated template once per persistent worker. Each worker resets its own database
  // between tests, avoiding cross-worker truncation races without paying process startup per case.
  for (const database of databases) {
    await admin.query(`create database ${quoteIdentifier(database)} template ${quoteIdentifier(templateDatabase)}`);
  }

  if (!interruptedSignal) {
    const shards = Array.from({ length: workerCount }, () => []);
    uniqueFiles.forEach((file, index) => shards[index % workerCount].push(file));
    console.log(`Running ${uniqueFiles.length} integration test files across ${workerCount} isolated databases`);
    const results = await Promise.all(shards.map((workerFiles, index) => runWorker(index, workerFiles)));
    exitCode = results.some((code) => code !== 0) ? 1 : 0;
  }
} finally {
  if (adminConnected) await dropDatabases();
  await admin.end().catch(() => undefined);
}

if (interruptedSignal) process.kill(process.pid, interruptedSignal);
process.exit(exitCode);
