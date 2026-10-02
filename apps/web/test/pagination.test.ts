import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/server/api/pagination";

const id = "00000000-0000-0000-0000-000000000001";

describe("decodeCursor", () => {
  it.each([
    "0000-01-01T00:00:00.000000Z",
    "2024-00-01T00:00:00.000000Z",
    "2024-13-01T00:00:00.000000Z",
    "2024-01-32T00:00:00.000000Z",
    "2024-02-30T00:00:00.000000Z",
    "2023-02-29T00:00:00.000000Z",
    "1900-02-29T00:00:00.000000Z",
    "2024-04-31T00:00:00.000000Z",
    "2024-01-01T25:00:00.000000Z",
    "2024-01-01T24:00:00.000000Z",
    "2024-01-01T00:60:00.000000Z",
    "2024-01-01T00:00:61.000000Z",
    "2024-01-01T23:59:60.000000Z",
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000000+00:00",
  ])("rejects %s with BAD_REQUEST", (createdAt) => {
    expect(() => decodeCursor(encodeCursor({ createdAt, id }))).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", status: 400 }),
    );
  });

  it.each([
    "0001-01-01T00:00:00.000000Z",
    "2000-02-29T00:00:00.000000Z",
    "2024-02-29T00:00:00.000000Z",
    "9999-12-31T23:59:59.999999Z",
  ])("preserves valid position %s exactly", (createdAt) => {
    expect(decodeCursor(encodeCursor({ createdAt, id }))).toEqual({ createdAt, id });
  });
});
