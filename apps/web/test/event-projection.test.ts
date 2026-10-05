import { randomUUID } from "node:crypto";
import {
  CLAIM_RELEASE_REASONS,
  type Event,
  eventMetadataSchema,
  eventSchema,
  knownEventSchema,
  MAX_EVENT_BYTES,
  UNAVAILABLE_EVENT_TYPE,
} from "@hivemind/contract";
import { type Event as EventRow, encodedJsonBytes, MAX_EVENT_PAYLOAD_BYTES } from "@hivemind/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEventProjector,
  EventProjectionError,
  type KnownEventDecoder,
  projectEvent,
} from "../src/server/event-projection";

// The shared Event projection (ADR-0015, issue #15). A reader that keeps
// this projection can read Events a newer deployment wrote: known Events come
// back unchanged, unreadable details become `event.unavailable`, and corrupt
// rows fail with an error that names no stored value.

const CANARY = "hm-canary-4f1b2c";

function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: randomUUID(),
    seq: "9007199254740993",
    writerXid: "9007199254740995",
    projectId: randomUUID(),
    type: "task.released",
    payloadVersion: 1,
    payload: { reason: "released" },
    actorKind: "project_key",
    actorUserId: null,
    actorKeyId: randomUUID(),
    actorSessionId: randomUUID(),
    planId: randomUUID(),
    taskId: randomUUID(),
    sessionId: randomUUID(),
    effectiveAt: new Date("2026-10-01T12:00:00.000Z"),
    creationFingerprint: "a".repeat(64),
    createdAt: new Date("2026-10-01T12:00:01.000Z"),
    ...overrides,
  };
}

/** The metadata of `stored` as an unavailable Event must carry it. */
function unavailableOf(stored: EventRow): Event {
  return {
    id: stored.id,
    projectId: stored.projectId,
    seq: stored.seq,
    writerXid: stored.writerXid,
    type: UNAVAILABLE_EVENT_TYPE,
    payloadVersion: 1,
    payload: {},
    actor: { kind: "project_key", keyId: stored.actorKeyId as string },
    actorSessionId: stored.actorSessionId,
    planId: stored.planId,
    taskId: stored.taskId,
    sessionId: stored.sessionId,
    effectiveAt: stored.effectiveAt.toISOString(),
    createdAt: stored.createdAt.toISOString(),
  };
}

function expectNoStoredDetails(projected: Event) {
  const encoded = JSON.stringify(projected);
  expect(encoded).not.toContain(CANARY);
  expect(encoded).not.toContain("creationFingerprint");
  expect(encoded).not.toContain("a".repeat(64));
}

/**
 * A reader built before #14 added the `stolen` release reason, pinned here
 * rather than derived from today's contract, so later changes to the current
 * vocabulary cannot quietly change what this older build knew. Never update
 * it when reasons or types are added.
 */
const OLDER_RELEASE_REASONS = [
  "released",
  "lease_expired",
  "session_stale",
  "session_ended",
  "session_abandoned",
  "plan_abandoned",
] as const;

function olderVariant<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({
    ...eventMetadataSchema.shape,
    type: z.literal(type),
    payloadVersion: z.literal(1),
    payload,
  });
}

const olderVocabulary = z.discriminatedUnion("type", [
  olderVariant("task.released", z.strictObject({ reason: z.enum(OLDER_RELEASE_REASONS) })),
  olderVariant("plan.log_appended", z.strictObject({ message: z.string() })),
]);

const readAsOlderBuild = createEventProjector(olderVocabulary as unknown as KnownEventDecoder);

describe("an older reader that keeps the projection", () => {
  const stolen = row({ payload: { reason: "stolen" } });

  it("pins a vocabulary that predates the stolen reason", () => {
    // If today's reasons drop one of these, the older reader no longer
    // stands for a real build and this test must be revisited.
    for (const reason of OLDER_RELEASE_REASONS) expect(CLAIM_RELEASE_REASONS).toContain(reason);
    expect(CLAIM_RELEASE_REASONS).toContain("stolen");
    expect(OLDER_RELEASE_REASONS).not.toContain("stolen" as never);
  });

  it("rejects the newer row with its own schema, as an unpatched reader did", () => {
    const dto = { ...unavailableOf(stolen), type: "task.released", payload: { reason: "stolen" } };
    expect(olderVocabulary.safeParse(dto).success).toBe(false);
  });

  it("reads the newer row as unavailable, keeping its metadata", () => {
    const projected = readAsOlderBuild(stolen);
    expect(projected).toEqual(unavailableOf(stolen));
    expect(eventSchema.parse(projected)).toEqual(projected);
  });

  it("still reads the Events it knows unchanged", () => {
    const released = row();
    expect(readAsOlderBuild(released)).toEqual(projectEvent(released));
    expect(readAsOlderBuild(released)).toMatchObject({ payload: { reason: "released" } });
  });

  it("withholds a type it never knew", () => {
    const claimed = row({
      type: "task.claimed",
      payload: { stolenFromSessionId: null, leaseExpiresAt: "2026-10-01T12:05:00.000Z" },
    });
    expect(projectEvent(claimed).type).toBe("task.claimed");
    expect(readAsOlderBuild(claimed)).toEqual(unavailableOf(claimed));
  });

  it("while today's reader returns the stolen release itself", () => {
    expect(projectEvent(stolen)).toEqual({
      ...unavailableOf(stolen),
      type: "task.released",
      payload: { reason: "stolen" },
    });
  });
});

describe("projectEvent", () => {
  it("returns a known Event unchanged, without undeclared row fields", () => {
    const stored = row({ type: "plan.log_appended", payload: { message: "Ready for review." } });
    const projected = projectEvent(stored);
    expect(projected).toEqual({
      ...unavailableOf(stored),
      type: "plan.log_appended",
      payload: { message: "Ready for review." },
    });
    expect(knownEventSchema.parse(projected)).toEqual(projected);
    expect(JSON.stringify(projected)).not.toContain("creationFingerprint");
  });

  it.each([
    ["an unknown type", { type: "adr.created", payload: { title: CANARY } }],
    ["the reserved type", { type: UNAVAILABLE_EVENT_TYPE, payload: { note: CANARY } }],
    ["a newer reason", { payload: { reason: `${CANARY}_reason` } }],
    ["a newer payload version", { payloadVersion: 2, payload: { reason: "released" } }],
    [
      "a newer version of a familiar payload",
      { type: "plan.log_appended", payloadVersion: 2, payload: { message: CANARY } },
    ],
    ["an extra payload field", { payload: { reason: "released", token: CANARY } }],
    ["a missing payload field", { payload: {} }],
    ["a mistyped payload field", { payload: { reason: 7 } }],
    ["a payload that is not an object", { payload: [CANARY] }],
    ["a null payload", { payload: null }],
  ] as const)("withholds %s as event.unavailable", (_, overrides) => {
    const stored = row(overrides as Partial<EventRow>);
    const projected = projectEvent(stored);
    expect(projected).toEqual(unavailableOf(stored));
    expectNoStoredDetails(projected);
    expect(JSON.stringify(projected)).not.toContain("adr.created");
  });

  it.each([
    { actorKind: "user" as const, actorUserId: randomUUID(), actorKeyId: null },
    { actorKind: "system" as const, actorUserId: null, actorKeyId: null, actorSessionId: null },
  ])("keeps a $actorKind actor on an unavailable Event", (actor) => {
    const stored = row({ ...actor, type: "future.thing" });
    const projected = projectEvent(stored);
    expect(projected.type).toBe(UNAVAILABLE_EVENT_TYPE);
    expect(projected.actor).toEqual(
      actor.actorKind === "user" ? { kind: "user", userId: actor.actorUserId } : { kind: "system" },
    );
    expect(projected.actorSessionId).toBe(stored.actorSessionId);
  });

  it("withholds a newer payload up to the writer's size limit", () => {
    const padding = MAX_EVENT_PAYLOAD_BYTES - encodedJsonBytes({ note: "" });
    const stored = row({ type: "future.thing", payload: { note: "x".repeat(padding) } });
    expect(encodedJsonBytes(stored.payload)).toBe(MAX_EVENT_PAYLOAD_BYTES);
    expect(projectEvent(stored)).toEqual(unavailableOf(stored));
  });

  it("fails when a decoded Event would encode over 64 KiB", () => {
    const stored = row({ type: "plan.log_appended", payload: { message: "short" } });
    const oversized: KnownEventDecoder = {
      safeParse: (value) => ({
        success: true,
        data: {
          ...(value as Event),
          payload: { message: CANARY.repeat(MAX_EVENT_BYTES) },
        } as never,
      }),
    };
    expect(() => createEventProjector(oversized)(stored)).toThrow(EventProjectionError);
    expect(() => createEventProjector(oversized)(stored)).toThrow(/event_too_large/);
    expect(() => createEventProjector(oversized)(stored)).not.toThrow(new RegExp(CANARY));
  });

  describe("corrupt rows", () => {
    const failures: Array<[string, Partial<EventRow>, string]> = [
      ["an invalid id", { id: CANARY }, "invalid_metadata"],
      ["an invalid Project id", { projectId: CANARY }, "invalid_metadata"],
      ["an invalid seq", { seq: `-${CANARY}` }, "invalid_metadata"],
      ["an invalid writer_xid", { writerXid: "1e3" }, "invalid_metadata"],
      ["an invalid affected Plan", { planId: CANARY }, "invalid_metadata"],
      ["an invalid actor Session", { actorSessionId: CANARY }, "invalid_metadata"],
      ["an actor without its id", { actorKind: "user", actorUserId: null }, "invalid_metadata"],
      ["an unknown actor kind", { actorKind: CANARY as EventRow["actorKind"] }, "invalid_metadata"],
      ["an invalid timestamp", { effectiveAt: new Date(Number.NaN) }, "invalid_metadata"],
      ["payload version 0", { payloadVersion: 0 }, "invalid_payload_version"],
      ["a negative payload version", { payloadVersion: -2 }, "invalid_payload_version"],
      ["a fractional payload version", { payloadVersion: 1.5 }, "invalid_payload_version"],
      [
        "a payload over the writer's limit",
        { type: "future.thing", payload: { note: CANARY.repeat(MAX_EVENT_PAYLOAD_BYTES) } },
        "payload_too_large",
      ],
      [
        "a known payload over the writer's limit",
        { type: "plan.log_appended", payload: { message: CANARY.repeat(MAX_EVENT_BYTES) } },
        "payload_too_large",
      ],
    ];

    it.each(failures)("fails on %s with a sanitized error", (_, overrides, code) => {
      const stored = row(overrides);
      let thrown: unknown;
      try {
        projectEvent(stored);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(EventProjectionError);
      const error = thrown as EventProjectionError;
      expect(error.code).toBe(code);
      expect(error.message).toContain(code);
      expect(error.message).not.toContain(CANARY);
      expect(error.message).not.toContain(String(stored.type));
      expect(error.cause).toBeUndefined();
      // The UUID helps an operator find the row; an invalid one is omitted.
      if (stored.id === CANARY) expect(error.message).toContain("with an invalid id");
      else expect(error.message).toContain(stored.id);
    });
  });
});
