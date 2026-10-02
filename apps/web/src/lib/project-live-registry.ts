import { compareFeedPositions, decodeFeedCursor } from "@hivemind/contract";
import {
  type LiveUpdateScope,
  liveUpdateScopeKey,
  shouldRefreshFor,
} from "./project-event-filters";
import type {
  ProjectEventStream,
  ProjectEventStreamSnapshot,
  StreamEvent,
} from "./project-event-stream";

// Which page a Project's single live subscription serves (issue #11,
// ADR-0010). The provider mounts in the Project layout, which does not
// re-render when the User moves between the Project's pages, so it cannot
// read a page's snapshot fence itself. Each page instead registers the fence
// and scope of the render it shows; this registry starts one stream from the
// first page's fence and keeps it, with its cursor, across navigation and
// refreshes.
//
// Losslessness. A page's snapshot contains every Event before its fence F.
// The stream processes Events in cursor order and filters each with the
// scope active when it arrives. When a page with a different scope becomes
// active while the stream's processed cursor C is past F, Events in (F, C]
// may be missing from the page and were filtered with another page's scope,
// so the page is refreshed once. That refresh reads a snapshot taken after
// every Event up to C was delivered, hence committed; Events after C are
// filtered with the new scope. With an unchanged scope (the same page after
// a refresh, or another page with the same filter) every Event was already
// filtered correctly: a relevant one requested a refresh after it arrived,
// and the router runs that refresh after any navigation in progress, so it
// re-reads the page on screen. A stream behind F only repeats Events the
// page already has: duplicates, which are harmless.
//
// Hidden layouts. With `cacheComponents`, Next keeps a layout the User leaves
// hidden in a React Activity instead of unmounting it, and shows it again,
// with the pages it rendered, on Back. Hiding detaches the registry, which
// closes the stream. Lost access is kept across that, so the hidden layout
// keeps showing the message rather than the pre-loss content. A stream
// started after a detach refreshes the restored page at once, since it may
// be any age.

/** What a rendered Project page registers: its snapshot's fence and what it shows. */
export interface LivePage {
  projectId: string;
  /** The feed cursor of the render's snapshot fence (`ProjectPageBase.feedCursor`). */
  cursor: string;
  scope: LiveUpdateScope;
  /** When the render's snapshot was read (epoch ms), if the page knows. */
  asOf?: number;
}

export interface LiveStreamRequest {
  projectId: string;
  initialCursor: string;
  /** When the page on screen was read (epoch ms); null if unknown. */
  lastSyncAt: number | null;
  shouldRefresh: (event: StreamEvent) => boolean;
}

export interface ProjectLiveRegistry {
  /** Adds or updates the registration `id` (one per mounted page). */
  register(id: string, page: LivePage): void;
  unregister(id: string): void;
  /** The provider is mounted and visible: a registered page may start the stream. */
  attach(): void;
  /** The provider is unmounted or hidden: closes the stream. Lost access is kept. */
  detach(): void;
  /**
   * The current pathname. After lost access, no stream runs until the
   * pathname changes (a fresh navigation) or a page registers a newer fence
   * (a fresh server render); then that page starts a new stream from its own
   * fence.
   */
  navigated(pathname: string): void;
  /** The stream's state, the lost-access state, or null when no stream runs. */
  getSnapshot(): ProjectEventStreamSnapshot | null;
  subscribe(listener: () => void): () => void;
}

/** Whether the stream's processed cursor is past the page's fence (or either is unreadable). */
export function streamIsPastFence(
  streamCursor: string,
  pageCursor: string,
  projectId: string,
): boolean {
  const stream = decodeFeedCursor(streamCursor, projectId);
  const page = decodeFeedCursor(pageCursor, projectId);
  if (!stream.ok || !page.ok) return true;
  return compareFeedPositions(stream.position, page.position) > 0;
}

/** Whether `cursor` is a later fence than `than` (or, if either is unreadable, a different one). */
function isNewerFence(cursor: string, than: string, projectId: string): boolean {
  const next = decodeFeedCursor(cursor, projectId);
  const previous = decodeFeedCursor(than, projectId);
  if (!next.ok || !previous.ok) return cursor !== than;
  return compareFeedPositions(next.position, previous.position) > 0;
}

/** Where access was lost; kept until a fresh navigation or render. */
interface LostAccess {
  pathname: string;
  projectId: string;
  /** The fence of the page on screen when access was lost. */
  cursor: string;
  /** The stream's access-lost snapshot. */
  snapshot: ProjectEventStreamSnapshot;
}

export function createProjectLiveRegistry(options: {
  createStream: (request: LiveStreamRequest) => ProjectEventStream;
}): ProjectLiveRegistry {
  // Insertion-ordered; the newest registration is the page on screen.
  const pages = new Map<string, LivePage>();
  const listeners = new Set<() => void>();
  let attached = false;

  let stream: ProjectEventStream | null = null;
  let stopListening: (() => void) | null = null;
  let streamProjectId: string | null = null;
  let streamStartCursor: string | null = null;
  let filterScope: LiveUpdateScope | null = null;
  let filterKey: string | null = null;

  let pathname: string | null = null;
  let lost: LostAccess | null = null;
  // Set by detach(): the next stream's page may have been hidden for a while.
  let restored = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const activePage = (): LivePage | null => {
    let last: LivePage | null = null;
    for (const page of pages.values()) last = page;
    return last;
  };

  const closeStream = () => {
    if (!stream) return;
    stopListening?.();
    stopListening = null;
    stream.close();
    stream = null;
    streamProjectId = null;
    streamStartCursor = null;
    filterScope = null;
    filterKey = null;
    notify();
  };

  const clearLost = () => {
    lost = null;
    closeStream();
    notify();
  };

  const onStreamChange = () => {
    const snapshot = stream?.getSnapshot();
    if (snapshot?.status.kind === "access-lost" && lost === null && streamProjectId !== null) {
      lost = {
        pathname: pathname ?? "",
        projectId: streamProjectId,
        cursor: activePage()?.cursor ?? streamStartCursor ?? "",
        snapshot,
      };
    }
    notify();
  };

  const startStream = (page: LivePage) => {
    filterScope = page.scope;
    filterKey = liveUpdateScopeKey(page.scope);
    streamProjectId = page.projectId;
    streamStartCursor = page.cursor;
    const reconcile = restored;
    restored = false;
    const created = options.createStream({
      projectId: page.projectId,
      initialCursor: page.cursor,
      lastSyncAt: page.asOf ?? null,
      shouldRefresh: (event) => (filterScope ? shouldRefreshFor(filterScope, event) : true),
    });
    stream = created;
    stopListening = created.subscribe(onStreamChange);
    created.start();
    // A page shown again from a hidden layout may be any age, and lease and
    // liveness displays change with time alone.
    if (reconcile) created.invalidate();
    notify();
  };

  const sync = () => {
    if (!attached) return;
    const page = activePage();
    // Between pages (a loading page) the stream keeps its last filter.
    if (!page) return;
    if (lost) {
      // Only a fresh server render, which authorized the read again, ends it.
      if (
        page.projectId === lost.projectId &&
        !isNewerFence(page.cursor, lost.cursor, page.projectId)
      ) {
        return;
      }
      clearLost();
    }
    if (stream && streamProjectId !== page.projectId) closeStream();
    if (stream) {
      const status = stream.getSnapshot().status.kind;
      if (status === "access-lost") return;
      if (status === "error" || status === "closed") {
        // A stopped stream restarts only from a different render's fence, so
        // a cursor the server rejects is not retried in a loop.
        if (page.cursor === streamStartCursor) return;
        closeStream();
      }
    }
    if (!stream) {
      startStream(page);
      return;
    }
    // A stream whose resume cursor was rejected waits for a fresh fence.
    if (stream.adoptFence(page.cursor)) streamStartCursor = page.cursor;
    const key = liveUpdateScopeKey(page.scope);
    filterScope = page.scope;
    if (key === filterKey) return;
    filterKey = key;
    if (streamIsPastFence(stream.getSnapshot().cursor, page.cursor, page.projectId)) {
      stream.invalidate();
    }
  };

  return {
    register(id, page) {
      pages.set(id, page);
      sync();
    },
    unregister(id) {
      if (pages.delete(id)) sync();
    },
    attach() {
      if (attached) return;
      attached = true;
      sync();
    },
    detach() {
      if (attached) restored = true;
      attached = false;
      closeStream();
    },
    navigated(next) {
      pathname = next;
      if (lost !== null && next !== lost.pathname) {
        clearLost();
        sync();
      }
    },
    getSnapshot: () => lost?.snapshot ?? stream?.getSnapshot() ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
