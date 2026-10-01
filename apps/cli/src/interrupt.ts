/**
 * SIGINT/SIGTERM handling for the compiled binary (wired in index.ts).
 *
 * The first signal aborts `signal`: device polling, prompts and requests watch
 * it, and the command ends with CANCELLED (exit 1) and its normal output, such
 * as the `--json` error envelope. A later signal exits 130 at once, for a
 * command that does not stop.
 *
 * A repeat of the SAME signal within `windowMs` of the first counts as the
 * same interruption. One Ctrl+C can arrive twice: the terminal sends SIGINT to
 * the whole foreground process group, so under a wrapper that forwards signals
 * (the npm launcher, npm/bin/hivemind.js, or a supervisor killing a process
 * group) the binary gets the terminal's copy and the forwarded one within
 * milliseconds. Without the window that pair looked like "Ctrl+C twice" and
 * skipped the clean cancel. The cost: a deliberate second Ctrl+C within the
 * window is ignored, so forcing an exit takes one more press.
 */

/** Long enough for a forwarded copy of a signal, short enough to feel like one keypress. */
export const REPEAT_WINDOW_MS = 500;

export interface InterruptHandlerOptions {
  /** Called with 130 for an interruption that should end the process now. */
  exit: (code: number) => void;
  now?: () => number;
  windowMs?: number;
}

export interface InterruptHandler {
  /** Aborted by the first signal; its reason names the signal. */
  readonly signal: AbortSignal;
  /** Call from `process.on(name, ...)`. */
  handle(name: string): void;
}

export function createInterruptHandler(options: InterruptHandlerOptions): InterruptHandler {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? REPEAT_WINDOW_MS;
  const controller = new AbortController();
  let first: { name: string; at: number } | null = null;
  return {
    signal: controller.signal,
    handle(name) {
      if (first === null) {
        first = { name, at: now() };
        controller.abort(new Error(`received ${name}`));
        return;
      }
      if (name === first.name && now() - first.at < windowMs) return;
      options.exit(130);
    },
  };
}
