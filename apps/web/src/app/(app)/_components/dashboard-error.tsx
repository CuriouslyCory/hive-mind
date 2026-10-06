"use client";

import { Button } from "../../../design-system/button";

// The error boundary of the dashboard's pages, inside the app shell. Server
// errors reach the browser only as a digest (Next.js hides their messages in
// production), so nothing from the failed read is shown beyond that
// reference.
export function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="app-message">
      <h1>Something went wrong</h1>
      <p role="alert">
        This page could not be loaded. Try again; if it keeps failing, report the reference below.
      </p>
      {error.digest && (
        <p>
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <p className="app-message-actions">
        <Button variant="primary" onClick={() => retry()}>
          Try again
        </Button>
        <Button href="/">Back to your Projects</Button>
      </p>
    </div>
  );
}
