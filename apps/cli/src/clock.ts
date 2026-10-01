import { CLI_ERROR_CODES, CliError } from "./errors.ts";

/**
 * Time and waiting, behind an interface so device-login polling can be tested
 * with a fake clock instead of real five-second sleeps.
 */
export interface Clock {
  /** Milliseconds, monotonic within a run. */
  now(): number;
  /** Resolves after `ms`; rejects with a CANCELLED `CliError` when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export function cancelledError(cause?: unknown): CliError {
  return new CliError(CLI_ERROR_CODES.cancelled, "Cancelled.", { cause });
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelledError(signal.reason));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(cancelledError(signal.reason));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};
