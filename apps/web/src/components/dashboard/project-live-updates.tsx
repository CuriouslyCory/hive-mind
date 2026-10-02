"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { type LiveUpdateScope, shouldRefreshFor } from "../../lib/project-event-filters";
import {
  createProjectEventStream,
  type ProjectEventStreamSnapshot,
} from "../../lib/project-event-stream";

/**
 * Longest wait for a refresh's transition to finish before the scheduler
 * treats it as done, so a refresh that never reports completion cannot stop
 * later ones.
 */
const REFRESH_SETTLE_TIMEOUT_MS = 20_000;

/** The live-update state of the enclosing `ProjectLiveUpdates`; null before it connects. */
const LiveSnapshotContext = createContext<ProjectEventStreamSnapshot | null>(null);

export function useProjectLiveSnapshot(): ProjectEventStreamSnapshot | null {
  return useContext(LiveSnapshotContext);
}

export interface ProjectLiveUpdatesProps {
  projectId: string;
  /** The fence cursor the server issued with this render's snapshot (ADR-0010). */
  initialCursor: string;
  /** What the page shows, which decides the Events that refresh it. */
  scope: LiveUpdateScope;
  children: ReactNode;
}

/**
 * Keeps a Project page current: one subscription to the Project's Event
 * feed per mounted Project, whose invalidations re-read the page with
 * `router.refresh()`. The subscription and its cursor survive refreshes
 * (which re-render this component with a new `initialCursor` and `scope`);
 * it restarts only when `projectId` changes, from that render's cursor.
 *
 * `router.refresh()` returns nothing, so completion is observed through a
 * transition: the refresh runs inside `startTransition`, and the promise the
 * scheduler awaits resolves when `isPending` returns to false, i.e. when
 * React has committed the refreshed Server Component payload. Invalidations
 * arriving meanwhile cause exactly one more refresh.
 *
 * When the stream reports lost access, the children (this Project's
 * protected content) are replaced by a message until a fresh navigation.
 */
export function ProjectLiveUpdates({
  projectId,
  initialCursor,
  scope,
  children,
}: ProjectLiveUpdatesProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [snapshot, setSnapshot] = useState<ProjectEventStreamSnapshot | null>(null);
  const waiters = useRef<(() => void)[]>([]);
  const sawPending = useRef(false);

  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(settle, REFRESH_SETTLE_TIMEOUT_MS);
        waiters.current.push(settle);
        startTransition(() => {
          router.refresh();
        });
      }),
    [router],
  );

  useEffect(() => {
    if (isPending) {
      sawPending.current = true;
      return;
    }
    if (!sawPending.current) return;
    sawPending.current = false;
    for (const settle of waiters.current.splice(0)) settle();
  }, [isPending]);

  // The latest props, read by the long-lived subscription without restarting it.
  const latest = useRef({ initialCursor, scope, refresh });
  useEffect(() => {
    latest.current = { initialCursor, scope, refresh };
  });

  useEffect(() => {
    const stream = createProjectEventStream({
      projectId,
      initialCursor: latest.current.initialCursor,
      refresh: () => latest.current.refresh(),
      shouldRefresh: (event) => shouldRefreshFor(latest.current.scope, event),
    });
    setSnapshot(stream.getSnapshot());
    const unsubscribe = stream.subscribe(() => setSnapshot(stream.getSnapshot()));
    stream.start();
    return () => {
      unsubscribe();
      stream.close();
      for (const settle of waiters.current.splice(0)) settle();
    };
  }, [projectId]);

  if (snapshot?.status.kind === "access-lost") {
    return (
      <LiveSnapshotContext value={snapshot}>
        <div role="alert">
          <p>
            {snapshot.status.code === "UNAUTHORIZED"
              ? "Your sign-in has ended, so this Project is hidden."
              : "You no longer have access to this Project, so it is hidden."}
          </p>
          <p>
            <a href="/">Go to the dashboard</a>
          </p>
        </div>
      </LiveSnapshotContext>
    );
  }

  return <LiveSnapshotContext value={snapshot}>{children}</LiveSnapshotContext>;
}
