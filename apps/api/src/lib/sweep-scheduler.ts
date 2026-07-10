import type { FastifyBaseLogger } from "fastify";

/**
 * Shared scheduler for recurring background "sweep" tasks (email, push, webhooks,
 * realtime outbox, digests, automations, cleanups).
 *
 * The product invariant for every sweeper is: a run must never overlap itself, and the
 * next run is queued only AFTER the current one fully settles. So if a task that is
 * meant to run every 10s takes 500s, no second run starts until the 500s run finishes,
 * and only then is the next run scheduled. This helper makes that guarantee structural
 * (single-flight + reschedule-inside-finally) so individual sweepers can't reintroduce
 * the re-entrance bug.
 *
 * `nextDelayMs` is evaluated from the task's own result after each completion. Returning
 * `<= 0` collapses "the next window" to ~0ms, which lets batch drainers keep draining a
 * known backlog back-to-back without ever overlapping a run — the latency floor stays at
 * "as fast as the previous run can finish", never an idle poll interval.
 */
export interface SweepSchedulerOptions<TResult> {
  /** Stable name used in log context. */
  name: string;
  /** The sweep body. Its resolved value feeds `nextDelayMs`. */
  task: () => Promise<TResult>;
  /**
   * Fixed delay, or a function evaluated after each completion to compute the delay
   * until the next run. A value `<= 0` means "continue as soon as possible" (still
   * single-flight). On task error the result is unavailable, so the fallback fixed
   * value is used when `nextDelayMs` is a number; when it is a function it is called
   * with `undefined`.
   */
  nextDelayMs: number | ((result: TResult | undefined) => number);
  /** Run once immediately on start (default), or wait the first delay before the first run. */
  runImmediately?: boolean;
  /**
   * Delay before the very first run when `runImmediately` is false. Defaults to
   * `nextDelayMs` evaluated with no result. Use this when the first run should align to a
   * boundary (e.g. the next hour) but subsequent runs use a different cadence.
   */
  firstDelayMs?: number | (() => number);
  log?: FastifyBaseLogger;
}

export interface SweepScheduler {
  /** Stop scheduling, cancel any pending timer, and wait for an in-flight run to finish. */
  stop: () => Promise<void>;
  /**
   * Wake early (e.g. from a Postgres NOTIFY or a sibling scheduler). If idle, runs now;
   * if a run is in flight, coalesces to exactly one rerun on completion — never stacks
   * and never overlaps.
   */
  trigger: () => void;
}

export function startSweepScheduler<TResult>(options: SweepSchedulerOptions<TResult>): SweepScheduler {
  const { name, task, nextDelayMs, runImmediately = true, firstDelayMs, log } = options;

  let stopped = false;
  let running = false;
  // A trigger() arrived while a run was in flight; run exactly once more on completion.
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stoppedPromise: Promise<void> | null = null;
  let resolveStopped: (() => void) | null = null;

  const resolveDelay = (result: TResult | undefined): number =>
    typeof nextDelayMs === "function" ? nextDelayMs(result) : nextDelayMs;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    // Clamp to >= 0 so a "continue ASAP" still goes through the event loop (setTimeout 0)
    // rather than recursing synchronously — keeps other work unstarved and the stack flat.
    timer = setTimeout(runOnce, Math.max(0, delayMs));
    timer.unref?.();
  };

  const runOnce = () => {
    if (stopped || running) return;
    timer = null;
    running = true;
    void task()
      .then(
        (result) => ({ ok: true as const, result }),
        (err) => {
          log?.error({ err, scheduler: name }, "sweep scheduler task failed");
          return { ok: false as const, result: undefined };
        },
      )
      .then(({ result }) => {
        running = false;
        if (stopped) {
          resolveStopped?.();
          resolveStopped = null;
          return;
        }
        if (pending) {
          // A wake landed during the run — service it immediately instead of waiting a window.
          pending = false;
          runOnce();
          return;
        }
        scheduleNext(resolveDelay(result));
      });
  };

  const trigger = () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    runOnce();
  };

  if (runImmediately) {
    runOnce();
  } else {
    const firstDelay = firstDelayMs === undefined
      ? resolveDelay(undefined)
      : typeof firstDelayMs === "function" ? firstDelayMs() : firstDelayMs;
    scheduleNext(firstDelay);
  }

  return {
    stop: () => {
      stopped = true;
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Fastify's onClose hooks await this promise before the shared database pool is
      // closed. Without draining the active task, a dev restart can close Postgres while
      // immediate startup sweeps are still querying it and produce a cascade of errors.
      if (!running) return Promise.resolve();
      stoppedPromise ??= new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      return stoppedPromise;
    },
    trigger,
  };
}
