import { readFileSync } from "node:fs";
import { expect } from "vitest";

/** A golden v1 file from packages/contract/test/fixtures/v1. */
export function golden(name: string): unknown {
  const dir = new URL("../../../../packages/contract/test/fixtures/v1/", import.meta.url);
  return JSON.parse(readFileSync(new URL(name, dir), "utf8"));
}

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Asserts that `actual` has every field of `fixture` with the same type,
 * recursively. Extra fields pass (adding a field is compatible, AGENTS.md).
 * A null on either side passes for that field, since fixtures show one case
 * of a nullable field. Array elements are compared with the fixture's first
 * element, so sections may hold a different number of entries.
 */
export function expectShape(actual: unknown, fixture: unknown, path = "$"): void {
  if (actual === null || fixture === null) return;
  expect(kind(actual), path).toBe(kind(fixture));
  if (Array.isArray(fixture)) {
    const [model] = fixture;
    if (model === undefined) return;
    (actual as unknown[]).forEach((item, index) => {
      expectShape(item, model, `${path}[${index}]`);
    });
    return;
  }
  if (typeof fixture === "object") {
    for (const [key, value] of Object.entries(fixture as Record<string, unknown>)) {
      expect(Object.hasOwn(actual as object, key), `${path}.${key}`).toBe(true);
      expectShape((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
  }
}

/** The envelope has the golden file's command, ok flag and data shape. */
export function expectGolden(envelope: unknown, name: string): void {
  const fixture = golden(name) as { command: string; ok: boolean };
  expect(envelope).toMatchObject({ schemaVersion: 1, command: fixture.command, ok: fixture.ok });
  expectShape(envelope, fixture);
}
