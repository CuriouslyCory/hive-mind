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
//
// Lost access ends only when the server accepts a stream started after a
// fresh navigation (a new pathname). Until that stream is live the content
// stays hidden, because Back or Forward can show a page kept in a hidden
// Activity, rendered before the loss, with no server render. The hidden
// content registers no page, so the check runs from the last page shown;
// once it passes, the page that registers next is refreshed. A newer fence
// does not start a check: a `router.refresh()` that started before the loss
// can commit after it, with a fence later than the lost page's, yet its
// render was authorized against the pre-loss state.

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
   * pathname changes (a fresh navigation); then the page on screen starts a
   * new stream from its own fence, and lost access ends once it is live.
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

/** Where access was lost; kept until a stream started after a fresh navigation is live. */
interface LostAccess {
  /** Where access was lost, or where the last check found it still lost. */
  pathname: string;
  /** The stream's access-lost snapshot, shown until access is back. */
  snapshot: ProjectEventStreamSnapshot;
  /** A stream started after a fresh navigation is checking whether access is back. */
  checking: boolean;
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
  // The page on screen when last seen; a check of lost access starts from it.
  let lastPage: LivePage | null = null;
  // Set when a check finds access back: the page shown next is refreshed.
  let revealed = false;

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

  const onStreamChange = () => {
    const snapshot = stream?.getSnapshot();
    const kind = snapshot?.status.kind;
    if (snapshot && kind === "access-lost" && (lost === null || lost.checking)) {
      lost = { pathname: pathname ?? "", snapshot, checking: false };
    } else if (lost?.checking && kind === "live") {
      // The server checked the login session and Project access before
      // accepting this stream, which started after the navigation.
      lost = null;
      revealed = true;
    }
    notify();
  };

  const startStream = (page: LivePage) => {
    filterScope = page.scope;
    filterKey = liveUpdateScopeKey(page.scope);
    streamProjectId = page.projectId;
    streamStartCursor = page.cursor;
    // A page shown again from a hidden layout, or after lost access, may be
    // any age, and lease and liveness displays change with time alone. A
    // check of lost access refreshes once it passes, not while hidden.
    const reconcile = (restored || revealed) && lost === null;
    restored = false;
    revealed = false;
    const created = options.createStream({
      projectId: page.projectId,
      initialCursor: page.cursor,
      lastSyncAt: page.asOf ?? null,
      shouldRefresh: (event) => (filterScope ? shouldRefreshFor(filterScope, event) : true),
    });
    stream = created;
    stopListening = created.subscribe(onStreamChange);
    created.start();
    if (reconcile) created.invalidate();
    notify();
  };

  const sync = () => {
    if (!attached) return;
    const shown = activePage();
    if (shown) lastPage = shown;
    // Between pages (a loading page) the stream keeps its last filter.
    const page = shown ?? (lost?.checking ? lastPage : null);
    if (!page) return;
    // Only a fresh navigation starts a stream after lost access (see `navigated`).
    if (lost && !lost.checking) return;
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
    if (revealed && shown) {
      revealed = false;
      filterKey = key;
      stream.invalidate();
      return;
    }
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
      if (lost !== null && !lost.checking && next !== lost.pathname) {
        lost = { ...lost, checking: true };
        closeStream();
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
