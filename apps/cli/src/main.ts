/**
 * CLI entrypoint.
 *
 * @kanera/mcp parses process.env at module load and, under NODE_ENV=production, validates two
 * server-only settings that an in-process CLI does not otherwise use. Supply inert local values
 * before importing it so the CLI never rewrites the caller's NODE_ENV.
 */
process.env.MCP_INTERNAL_SECRET ??= "kanera-cli-in-process-no-remote-transport-secret";
process.env.MCP_SERVER_PUBLIC_URL ??= "http://127.0.0.1";

const { run } = await import("./cli.js");

const exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = exitCode;
