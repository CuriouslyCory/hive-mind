"use client";

import Link from "next/link";

// The error boundary of the dashboard's pages. Server errors reach the
// browser only as a digest (Next.js hides their messages in production), so
// nothing from the failed read is shown beyond that reference.
export function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p role="alert">
        This page could not be loaded. Try again; if it keeps failing, report the reference below.
      </p>
      {error.digest && (
        <p className="muted">
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <p>
        <button type="button" onClick={() => retry()}>
          Try again
        </button>{" "}
        <Link href="/">Back to your Projects</Link>
      </p>
    </main>
  );
}
