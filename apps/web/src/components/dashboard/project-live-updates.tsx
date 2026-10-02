"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import type { LiveUpdateScope } from "../../lib/project-event-filters";
import {
  createProjectEventStream,
  type ProjectEventStreamSnapshot,
} from "../../lib/project-event-stream";
import {
  createProjectLiveRegistry,
  type ProjectLiveRegistry,
} from "../../lib/project-live-registry";

/**
 * Longest wait for a refresh's transition to finish before the scheduler
 * treats it as done, so a refresh that never reports completion cannot stop
 * later ones.
 */
const REFRESH_SETTLE_TIMEOUT_MS = 20_000;

/** The live-update state of the enclosing `ProjectLiveUpdates`; null while no stream runs. */
const LiveSnapshotContext = createContext<ProjectEventStreamSnapshot | null>(null);
const LiveRegistryContext = createContext<ProjectLiveRegistry | null>(null);

export function useProjectLiveSnapshot(): ProjectEventStreamSnapshot | null {
  return useContext(LiveSnapshotContext);
}

const serverSnapshot = () => null;

/**
 * Keeps a Project's pages current: one subscription to the Project's Event
 * feed while the Project layout is mounted, whose invalidations re-read the
 * page on screen with `router.refresh()`. It mounts in the layout so the
 * subscription and its cursor survive moving between the Project's pages
 * and refreshes. Pages tell it their snapshot fence and scope with
 * `ProjectLivePage`; the rules for adopting them are in
 * apps/web/src/lib/project-live-registry.ts. Leaving the Project unmounts
 * (or hides) the layout, which closes the stream.
 *
 * `router.refresh()` returns nothing, so completion is observed through a
 * transition: the refresh runs inside `startTransition`, and the promise the
 * scheduler awaits resolves when `isPending` returns to false, i.e. when
 * React has committed the refreshed Server Component payload. Invalidations
 * arriving meanwhile cause exactly one more refresh.
 */
export function ProjectLiveUpdates({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
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

  // The latest `refresh`, read by the long-lived stream without restarting it.
  const latestRefresh = useRef(refresh);
  useEffect(() => {
    latestRefresh.current = refresh;
  });

  const [registry] = useState(() =>
    createProjectLiveRegistry({
      createStream: (request) =>
        createProjectEventStream({ ...request, refresh: () => latestRefresh.current() }),
    }),
  );

  useEffect(() => {
    registry.attach();
    return () => {
      registry.detach();
      for (const settle of waiters.current.splice(0)) settle();
    };
  }, [registry]);

  const snapshot = useSyncExternalStore(registry.subscribe, registry.getSnapshot, serverSnapshot);

  return (
    <LiveRegistryContext value={registry}>
      <LiveSnapshotContext value={snapshot}>
        {/* The pathname is request data for a dynamic segment, so it waits in Suspense. */}
        <Suspense fallback={null}>
          <PathnameReporter registry={registry} />
        </Suspense>
        {children}
      </LiveSnapshotContext>
    </LiveRegistryContext>
  );
}

function PathnameReporter({ registry }: { registry: ProjectLiveRegistry }) {
  const pathname = usePathname();
  useEffect(() => {
    registry.navigated(pathname);
  }, [registry, pathname]);
  return null;
}

/**
 * Registers the page on screen with the enclosing `ProjectLiveUpdates`: the
 * fence cursor its server render was read at and what it shows. Render it
 * from the same snapshot as the page's data, so both change together on a
 * refresh. Renders nothing.
 */
export function ProjectLivePage({
  projectId,
  cursor,
  scope,
  asOf,
}: {
  projectId: string;
  /** The fence cursor the server issued with this render's snapshot (ADR-0010). */
  cursor: string;
  /** What the page shows, which decides the Events that refresh it. */
  scope: LiveUpdateScope;
  /** The database time of this render's snapshot. */
  asOf: Date;
}) {
  const registry = useContext(LiveRegistryContext);
  const id = useId();
  const asOfMs = asOf.getTime();

  useEffect(() => {
    registry?.register(id, { projectId, cursor, scope, asOf: asOfMs });
  }, [registry, id, projectId, cursor, scope, asOfMs]);

  useEffect(() => {
    if (!registry) return;
    return () => registry.unregister(id);
  }, [registry, id]);

  return null;
}

/**
 * The Project's protected content. When the stream reports lost access
 * (an `access_lost` frame, or HTTP 401 or 404 when connecting), it is
 * replaced by a message until the User navigates elsewhere and the server
 * accepts a new stream. The message stays while the layout is hidden and
 * when Back shows it again.
 */
export function ProjectLiveContent({ children }: { children: ReactNode }) {
  const snapshot = useProjectLiveSnapshot();
  if (snapshot?.status.kind !== "access-lost") return children;
  return (
    <main data-testid="project-access-lost">
      <div role="alert">
        <p>
          {snapshot.status.code === "UNAUTHORIZED"
            ? "Your sign-in has ended, so this Project is hidden."
            : "You no longer have access to this Project, so it is hidden."}
        </p>
        <p>
          <Link href="/">Go to all Projects</Link>
        </p>
      </div>
    </main>
  );
}
