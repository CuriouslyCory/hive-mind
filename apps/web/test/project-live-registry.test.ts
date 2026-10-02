import { randomUUID } from "node:crypto";
import { encodeFeedCursor } from "@hivemind/contract";
import { describe, expect, it, vi } from "vitest";
import { liveUpdateScopeKey } from "../src/lib/project-event-filters";
import {
  createProjectEventStream,
  type ProjectEventStream,
  type ProjectEventStreamSnapshot,
  type ProjectEventStreamStatus,
  type StreamEvent,
} from "../src/lib/project-event-stream";
import {
  createProjectLiveRegistry,
  type LivePage,
  type LiveStreamRequest,
  streamIsPastFence,
} from "../src/lib/project-live-registry";

const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();
const PLAN = randomUUID();
const SESSION = randomUUID();

const cursorAt = (xid: number, seq: number, projectId = PROJECT) =>
  encodeFeedCursor({ projectId, xid: String(xid), seq: String(seq) });

const overview = (xid: number, projectId = PROJECT): LivePage => ({
  projectId,
  cursor: cursorAt(xid, 0, projectId),
  scope: { kind: "project" },
});
const planPage = (xid: number, taskIds: string[] = []): LivePage => ({
  projectId: PROJECT,
  cursor: cursorAt(xid, 0),
  scope: { kind: "plan", planId: PLAN, taskIds, sessionIds: [] },
});
const sessionPage = (xid: number): LivePage => ({
  projectId: PROJECT,
  cursor: cursorAt(xid, 0),
  scope: { kind: "session", sessionId: SESSION },
});

function streamEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: randomUUID(),
    projectId: PROJECT,
    type: "plan.updated",
    seq: "1",
    writerXid: "100",
    actorSessionId: null,
    planId: randomUUID(),
    taskId: null,
    sessionId: null,
    payload: {},
    ...overrides,
  };
}

/** A stream double whose cursor and status the test sets. */
class FakeStream implements ProjectEventStream {
  started = false;
  closed = false;
  invalidations = 0;
  private snapshot: ProjectEventStreamSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(readonly request: LiveStreamRequest) {
    this.snapshot = {
      status: { kind: "connecting" },
      cursor: request.initialCursor,
      lastEventAt: null,
      lastSyncAt: 0,
      withheld: false,
      refreshing: false,
    };
  }

  /** Processes an Event: as the engine does, filter it, then move the cursor. */
  deliver(event: StreamEvent, cursor: string): boolean {
    const refresh = this.request.shouldRefresh(event);
    this.set({ cursor });
    return refresh;
  }

  set(patch: Partial<ProjectEventStreamSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  setStatus(status: ProjectEventStreamStatus) {
    this.set({ status });
  }

  start() {
    this.started = true;
  }
  reconcile() {}
  invalidate() {
    this.invalidations++;
  }
  close() {
    this.closed = true;
    this.set({ status: { kind: "closed" } });
  }
  getSnapshot() {
    return this.snapshot;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function setup() {
  const streams: FakeStream[] = [];
  const registry = createProjectLiveRegistry({
    createStream: (request) => {
      const stream = new FakeStream(request);
      streams.push(stream);
      return stream;
    },
  });
  const notified = vi.fn();
  registry.subscribe(notified);
  const current = () => {
    const stream = streams.at(-1);
    if (!stream) throw new Error("no stream");
    return stream;
  };
  return { registry, streams, current, notified };
}

describe("createProjectLiveRegistry", () => {
  it("starts one stream from the first page's fence once attached", () => {
    const { registry, streams, current } = setup();
    registry.register("a", overview(100));
    expect(streams).toHaveLength(0);
    expect(registry.getSnapshot()).toBeNull();

    registry.attach();
    expect(streams).toHaveLength(1);
    expect(current().started).toBe(true);
    expect(current().request).toMatchObject({
      projectId: PROJECT,
      initialCursor: cursorAt(100, 0),
    });
    expect(registry.getSnapshot()?.cursor).toBe(cursorAt(100, 0));
  });

  it("waits for a page when attached first (the page is still loading)", () => {
    const { registry, streams } = setup();
    registry.attach();
    expect(streams).toHaveLength(0);
    registry.register("a", planPage(100));
    expect(streams).toHaveLength(1);
  });

  it("keeps the stream and its cursor across pages, filtering with the page on screen", () => {
    const { registry, streams, current } = setup();
    registry.attach();
    registry.register("overview", overview(100));
    const stream = current();
    const unrelated = streamEvent();
    expect(stream.deliver(unrelated, cursorAt(101, 1))).toBe(true);

    registry.unregister("overview");
    registry.register("plan", planPage(102));
    expect(streams).toHaveLength(1);
    expect(stream.closed).toBe(false);
    expect(registry.getSnapshot()?.cursor).toBe(cursorAt(101, 1));
    expect(stream.deliver(streamEvent(), cursorAt(103, 1))).toBe(false);
    expect(stream.deliver(streamEvent({ planId: PLAN }), cursorAt(103, 2))).toBe(true);

    registry.unregister("plan");
    // Between pages the last filter stays.
    expect(stream.deliver(streamEvent(), cursorAt(104, 1))).toBe(false);
    registry.register("session", sessionPage(105));
    expect(stream.deliver(streamEvent({ sessionId: SESSION }), cursorAt(106, 1))).toBe(true);
    expect(streams).toHaveLength(1);
  });

  it("refreshes a newly shown page once when the stream has processed Events past its fence", () => {
    const { registry, current } = setup();
    registry.attach();
    registry.register("overview", overview(100));
    const stream = current();
    // Committed after the plan page's snapshot (fence 102) but filtered with
    // the overview's scope while the plan page loaded.
    stream.deliver(streamEvent(), cursorAt(103, 1));

    registry.unregister("overview");
    registry.register("plan", planPage(102));
    expect(stream.invalidations).toBe(1);
  });

  it("does not refresh a newly shown page whose fence is at or past the stream's cursor", () => {
    const { registry, current } = setup();
    registry.attach();
    registry.register("overview", overview(100));
    const stream = current();
    stream.deliver(streamEvent(), cursorAt(101, 1));

    registry.unregister("overview");
    registry.register("plan", planPage(102));
    expect(stream.invalidations).toBe(0);
    // The stream still owes Events between its cursor and the fence: they
    // are filtered with the plan page's scope, at worst a duplicate refresh.
    expect(registry.getSnapshot()?.cursor).toBe(cursorAt(101, 1));
  });

  it("adopts a refreshed render's scope without restarting, refreshing only when the scope changed", () => {
    const { registry, streams, current } = setup();
    registry.attach();
    registry.register("plan", planPage(100, ["t1"]));
    const stream = current();
    stream.deliver(streamEvent({ planId: PLAN }), cursorAt(102, 1));

    // The refresh's render: same Tasks, a newer fence. Nothing was filtered
    // with another scope, so no extra refresh.
    registry.register("plan", planPage(101, ["t1"]));
    expect(streams).toHaveLength(1);
    expect(stream.invalidations).toBe(0);

    // The next render lists another Task, and Events past its fence were
    // filtered without it.
    stream.deliver(streamEvent({ planId: PLAN }), cursorAt(104, 1));
    registry.register("plan", planPage(103, ["t1", "t2"]));
    expect(stream.invalidations).toBe(1);
    expect(stream.deliver(streamEvent({ taskId: "t2" }), cursorAt(105, 1))).toBe(true);
    expect(streams).toHaveLength(1);
  });

  it("stops after lost access until the pathname changes, then starts from the next page's fence", () => {
    const { registry, streams, current } = setup();
    registry.navigated("/projects/p");
    registry.attach();
    registry.register("overview", overview(100));
    const lost = current();
    lost.setStatus({ kind: "access-lost", code: "NOT_FOUND" });
    expect(registry.getSnapshot()?.status.kind).toBe("access-lost");

    // A page registering again (or a re-render) does not retry.
    registry.register("overview", overview(101));
    registry.navigated("/projects/p");
    expect(streams).toHaveLength(1);
    expect(registry.getSnapshot()?.status.kind).toBe("access-lost");

    registry.navigated("/projects/p/plans/P-1");
    expect(lost.closed).toBe(true);
    expect(streams).toHaveLength(2);
    expect(current().request.initialCursor).toBe(cursorAt(101, 0));
  });

  it("clears the stream when access was lost and no page is registered, then waits for one", () => {
    const { registry, streams, notified } = setup();
    registry.navigated("/projects/p");
    registry.attach();
    registry.register("overview", overview(100));
    streams[0]?.setStatus({ kind: "access-lost", code: "UNAUTHORIZED" });
    // The provider hides the protected content, unmounting the page.
    registry.unregister("overview");
    notified.mockClear();

    registry.navigated("/projects/p/sessions/s");
    expect(notified).toHaveBeenCalled();
    expect(registry.getSnapshot()).toBeNull();
    registry.register("session", sessionPage(110));
    expect(streams).toHaveLength(2);
    expect(streams[1]?.request.initialCursor).toBe(cursorAt(110, 0));
  });

  it("restarts a stream stopped by an error only from a different render's fence", () => {
    const { registry, streams, current } = setup();
    registry.attach();
    registry.register("overview", overview(100));
    current().setStatus({ kind: "error", reason: "bad-request" });

    registry.unregister("overview");
    registry.register("overview", overview(100));
    expect(streams).toHaveLength(1);

    registry.register("overview", overview(101));
    expect(streams).toHaveLength(2);
    expect(streams[0]?.closed).toBe(true);
    expect(current().request.initialCursor).toBe(cursorAt(101, 0));
  });

  it("closes the stream when detached and restarts from the latest render's fence", () => {
    const { registry, streams } = setup();
    registry.attach();
    registry.register("overview", overview(100));
    registry.register("overview", overview(105));
    registry.detach();
    expect(streams[0]?.closed).toBe(true);
    expect(registry.getSnapshot()).toBeNull();

    registry.register("overview", overview(106));
    expect(streams).toHaveLength(1);
    registry.attach();
    expect(streams).toHaveLength(2);
    expect(streams[1]?.request.initialCursor).toBe(cursorAt(106, 0));
  });

  it("closes the old Project's stream when a page of another Project registers", () => {
    const { registry, streams } = setup();
    registry.attach();
    registry.register("a", overview(100));
    registry.unregister("a");
    registry.register("b", overview(7, OTHER_PROJECT));
    expect(streams[0]?.closed).toBe(true);
    expect(streams[1]?.request).toMatchObject({
      projectId: OTHER_PROJECT,
      initialCursor: cursorAt(7, 0, OTHER_PROJECT),
    });
  });
});

describe("streamIsPastFence", () => {
  it("compares feed positions, and treats an unreadable cursor as past", () => {
    expect(streamIsPastFence(cursorAt(100, 1), cursorAt(100, 0), PROJECT)).toBe(true);
    expect(streamIsPastFence(cursorAt(100, 0), cursorAt(100, 0), PROJECT)).toBe(false);
    expect(streamIsPastFence(cursorAt(99, 5), cursorAt(100, 0), PROJECT)).toBe(false);
    expect(streamIsPastFence("garbage", cursorAt(100, 0), PROJECT)).toBe(true);
    expect(streamIsPastFence(cursorAt(1, 0, OTHER_PROJECT), cursorAt(100, 0), PROJECT)).toBe(true);
  });
});

describe("liveUpdateScopeKey", () => {
  it("ignores id order and duplicates, and tells scopes apart", () => {
    const a = liveUpdateScopeKey({ kind: "plan", planId: PLAN, taskIds: ["b", "a"] });
    const b = liveUpdateScopeKey({ kind: "plan", planId: PLAN, taskIds: ["a", "b", "a"] });
    expect(a).toBe(b);
    expect(a).not.toBe(liveUpdateScopeKey({ kind: "plan", planId: PLAN, taskIds: ["a"] }));
    expect(liveUpdateScopeKey({ kind: "project" })).not.toBe(
      liveUpdateScopeKey({ kind: "session", sessionId: SESSION }),
    );
  });
});

describe("ProjectEventStream.invalidate", () => {
  it("requests a refresh only while the stream runs", async () => {
    const refresh = vi.fn();
    const stream = createProjectEventStream({
      projectId: PROJECT,
      initialCursor: cursorAt(100, 0),
      refresh,
      fetch: () => new Promise<Response>(() => {}),
      document: null,
      window: null,
      url: "http://test.local/stream",
    });
    stream.invalidate();
    expect(refresh).not.toHaveBeenCalled();
    stream.start();
    stream.invalidate();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    stream.close();
    stream.invalidate();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
