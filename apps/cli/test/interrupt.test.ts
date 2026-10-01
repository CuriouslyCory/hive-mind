import { describe, expect, it } from "vitest";
import { createInterruptHandler, REPEAT_WINDOW_MS } from "../src/interrupt.ts";

function handler() {
  let now = 1_000;
  const exits: number[] = [];
  const interrupt = createInterruptHandler({ exit: (code) => exits.push(code), now: () => now });
  return {
    interrupt,
    exits,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createInterruptHandler", () => {
  it("cancels on the first signal and exits 130 on a later one", () => {
    const { interrupt, exits, advance } = handler();
    interrupt.handle("SIGINT");
    expect(interrupt.signal.aborted).toBe(true);
    expect((interrupt.signal.reason as Error).message).toBe("received SIGINT");
    expect(exits).toEqual([]);
    advance(REPEAT_WINDOW_MS);
    interrupt.handle("SIGINT");
    expect(exits).toEqual([130]);
  });

  it("treats a copy of the same signal within the window as the same interruption", () => {
    const { interrupt, exits, advance } = handler();
    interrupt.handle("SIGTERM");
    advance(5);
    interrupt.handle("SIGTERM");
    advance(REPEAT_WINDOW_MS - 10);
    interrupt.handle("SIGTERM");
    expect(exits).toEqual([]);
  });

  it("exits at once on a different signal, even within the window", () => {
    const { interrupt, exits } = handler();
    interrupt.handle("SIGINT");
    interrupt.handle("SIGTERM");
    expect(exits).toEqual([130]);
  });
});
