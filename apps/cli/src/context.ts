import type { RawFlag } from "./args.js";
import type { OutputMode } from "./output.js";
import type { ToolSession } from "./tools.js";

export interface CommandContext {
  positionals: string[];
  flags: Record<string, RawFlag>;
  apiKeyFlag?: string;
  urlFlag?: string;
  profileFlag?: string;
  mode: OutputMode;
  /**
   * Opened on first use and cached. Commands like `auth logout` and `commands` must work with no
   * credential at all, so resolving one is deferred rather than done during dispatch.
   */
  session(): Promise<ToolSession>;
  /** Tool metadata does not require authentication and must remain discoverable before login. */
  catalogSession(): Promise<ToolSession>;
}

export interface CommandResult {
  summary?: string;
  data?: unknown;
  tool?: string;
  /** Printed verbatim instead of rendered. Used where the output is meant for command substitution. */
  raw?: string;
}
