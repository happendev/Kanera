/**
 * Exit codes are part of the CLI's contract with agents and shell scripts: an agent that reads
 * stderr can only guess, but it can branch reliably on a number. The mapping mirrors the public
 * API's problem codes so `kanera` fails the same way the REST surface does.
 */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  unauthenticated: 3,
  forbidden: 4,
  notFound: 5,
  rateLimited: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the CLI itself detected (bad flags, no credential) rather than one the API returned. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.failed,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT.usage, hint);
}

/**
 * Map a public API problem document onto an exit code. Read-scoped credentials surface as
 * FORBIDDEN, which is why `forbidden` is distinct from the generic failure code: an agent handed a
 * read-only key needs to tell "I may not do this" apart from "this did not work".
 */
export function exitCodeForApiError(status: number, code?: string): ExitCode {
  if (status === 401 || code === "UNAUTHORIZED") return EXIT.unauthenticated;
  if (status === 403 || code === "FORBIDDEN") return EXIT.forbidden;
  if (status === 404 || code === "NOT_FOUND") return EXIT.notFound;
  if (status === 429 || code === "RATE_LIMITED") return EXIT.rateLimited;
  return EXIT.failed;
}
