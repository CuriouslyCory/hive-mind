import { CLI_ERROR_CODES, CliError } from "./errors.ts";

/**
 * Time and waiting, behind an interface so device-login polling can be tested
 * with a fake clock instead of real five-second sleeps, and ADR dates with a
 * fixed day.
 */
export interface Clock {
  /** Milliseconds, monotonic within a run. */
  now(): number;
  /**
   * Today's date in the local time zone, `YYYY-MM-DD`: the day `adr new`,
   * `adr status` and `adr supersede` write into an ADR. Local, not UTC, so a
   * change made late in the evening is not dated tomorrow.
   */
  today(): string;
  /** Resolves after `ms`; rejects with a CANCELLED `CliError` when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export function cancelledError(cause?: unknown): CliError {
  return new CliError(CLI_ERROR_CODES.cancelled, "Cancelled.", { cause });
}

/** `YYYY-MM-DD` of `date` in the local time zone. */
export function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  today: () => localDate(new Date()),
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
