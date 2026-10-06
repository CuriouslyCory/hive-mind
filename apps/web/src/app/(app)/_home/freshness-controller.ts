// The home page's refresh schedule, without React: `Freshness`
// (./freshness.tsx) wires it to the router. docs/dashboard.md → Home page →
// Live behavior.

/** How often the page re-reads its data while the tab is visible. */
export const HOME_REFRESH_MS = 15_000;

/**
 * Data younger than this is not re-read when the tab becomes visible or the
 * browser comes back online: switching tabs back and forth costs no reads.
 */
export const HOME_CATCH_UP_MS = 5_000;

/**
 * A refresh that has brought no new snapshot after this long is treated as
 * finished, like the Project pages' refreshes.
 */
export const HOME_REFRESH_TIMEOUT_MS = 20_000;

/** How many snapshots `createReceiptLog` remembers. */
const RECEIPT_LOG_CAPACITY = 64;

/** What a receipt log says about a snapshot it is given. */
export type Receipt = {
  /** When this client first received the snapshot. */
  receivedAt: number;
  /** The snapshot was not seen before and is the newest so far. */
  fresh: boolean;
  /** A newer snapshot has been received: this one is a restored older render. */
  older: boolean;
};

export interface ReceiptLog {
  receive(asOf: string, now: number): Receipt;
}

/**
 * When this client first received each snapshot (`asOf`, the snapshot's
 * database time). Back and Forward can show an older render of `/` (Next's
 * router cache, or a page kept in a hidden React Activity), and a remounted
 * component has no memory of its own, so the log outlives components: an
 * older snapshot keeps the age it had.
 */
export function createReceiptLog(capacity = RECEIPT_LOG_CAPACITY): ReceiptLog {
  const times = new Map<string, number>();
  let newest = Number.NEGATIVE_INFINITY;
  return {
    receive(asOf, now) {
      const at = Date.parse(asOf);
      const older = at < newest;
      const known = times.get(asOf);
      if (known !== undefined) return { receivedAt: known, fresh: false, older };
      if (older) {
        // Forgotten: the earliest receipt remembered is a lower bound on its age.
        return { receivedAt: Math.min(now, ...times.values()), fresh: false, older };
      }
      times.set(asOf, now);
      if (times.size > capacity) {
        const first = times.keys().next();
        if (!first.done) times.delete(first.value);
      }
      if (!Number.isNaN(at)) newest = at;
      return { receivedAt: now, fresh: true, older: false };
    },
  };
}

const sharedReceiptLog = createReceiptLog();

type DocumentLike = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

type WindowLike = {
  readonly navigator: { readonly onLine: boolean };
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
};

export type HomeFreshnessOptions = {
  /** Re-reads the page (`router.refresh()` in a transition). */
  refresh: () => void;
  intervalMs?: number;
  catchUpMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Defaults to the global `document`; null in tests that need none. */
  document?: DocumentLike | null;
  /** Defaults to the global `window`; null in tests that need none. */
  window?: WindowLike | null;
  /** Defaults to one log shared by every `Freshness` on the page. */
  log?: ReceiptLog;
};

export type HomeFreshnessSnapshot = {
  online: boolean;
  /** When the snapshot on screen was received; null before the first. */
  receivedAt: number | null;
};

export interface HomeFreshness {
  /** The page rendered snapshot `asOf` (on mount, on reveal, on every new render). */
  receive(asOf: string): void;
  /** The page is shown: listen, schedule, and catch up if the data is old. */
  start(): void;
  /** The page is hidden or unmounted: stop every timer and listener. */
  stop(): void;
  /** The refresh's transition ended, with or without a new snapshot. */
  settle(): void;
  getSnapshot(): HomeFreshnessSnapshot;
  subscribe(listener: () => void): () => void;
}

/**
 * Re-reads the home page every `intervalMs` while it is shown, visible and
 * online:
 *
 * - The age of the data runs from when this client first received the
 *   snapshot. Showing the page again (Back, a React Activity reveal) does not
 *   reset it; only a newer snapshot does.
 * - Showing the page refreshes at once when its data is older than the
 *   interval, or is an older snapshot than one already received. Becoming
 *   visible or online refreshes at once when the data is older than
 *   `catchUpMs`.
 * - One refresh at a time: a tick while one is in flight is skipped, until a
 *   new snapshot arrives, its transition ends, or `timeoutMs` passes.
 * - Every refresh restarts the interval, so two never fire back to back.
 * - No timer runs while the page is hidden, the tab is hidden or the browser
 *   is offline.
 */
export function createHomeFreshness(options: HomeFreshnessOptions): HomeFreshness {
  const intervalMs = options.intervalMs ?? HOME_REFRESH_MS;
  const catchUpMs = options.catchUpMs ?? HOME_CATCH_UP_MS;
  const timeoutMs = options.timeoutMs ?? HOME_REFRESH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? sharedReceiptLog;

  let snapshot: HomeFreshnessSnapshot = { online: true, receivedAt: null };
  const listeners = new Set<() => void>();
  let doc: DocumentLike | null = null;
  let win: WindowLike | null = null;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // When the refresh in flight started; null when none is.
  let pendingSince: number | null = null;
  // The snapshot on screen is older than one already received.
  let older = false;

  function update(patch: Partial<HomeFreshnessSnapshot>) {
    const next = { ...snapshot, ...patch };
    if (next.online === snapshot.online && next.receivedAt === snapshot.receivedAt) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  const visible = () => doc === null || doc.visibilityState === "visible";
  const online = () => win === null || win.navigator.onLine;
  const running = () => started && visible() && online();
  const age = () =>
    snapshot.receivedAt === null ? Number.POSITIVE_INFINITY : now() - snapshot.receivedAt;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delay: number) {
    clearTimer();
    if (running()) timer = setTimeout(refresh, Math.max(0, delay));
  }

  function refresh() {
    clearTimer();
    if (!running()) return;
    if (pendingSince === null || now() - pendingSince >= timeoutMs) {
      pendingSince = now();
      options.refresh();
    }
    schedule(intervalMs);
  }

  /** Refresh now if the data is `minAge` old (or older than one received), else when it is due. */
  function catchUp(minAge: number) {
    if (!running()) {
      clearTimer();
      return;
    }
    const current = age();
    if (older || current >= minAge) refresh();
    else schedule(intervalMs - current);
  }

  const onVisibility = () => catchUp(catchUpMs);
  const onOnline = () => {
    update({ online: true });
    catchUp(catchUpMs);
  };
  const onOffline = () => {
    update({ online: false });
    clearTimer();
  };

  return {
    receive(asOf) {
      const receipt = log.receive(asOf, now());
      older = receipt.older;
      update({ receivedAt: receipt.receivedAt });
      if (receipt.fresh) {
        pendingSince = null;
        schedule(intervalMs);
      } else if (older && started) {
        refresh();
      }
    },
    start() {
      if (started) return;
      started = true;
      doc = options.document === undefined ? globalThis.document : options.document;
      win = options.window === undefined ? globalThis.window : options.window;
      doc?.addEventListener("visibilitychange", onVisibility);
      win?.addEventListener("online", onOnline);
      win?.addEventListener("offline", onOffline);
      update({ online: online() });
      catchUp(intervalMs);
    },
    stop() {
      if (!started) return;
      started = false;
      clearTimer();
      doc?.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("online", onOnline);
      win?.removeEventListener("offline", onOffline);
    },
    settle() {
      pendingSince = null;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
