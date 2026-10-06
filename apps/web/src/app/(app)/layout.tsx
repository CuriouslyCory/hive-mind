import { Suspense } from "react";
import { AppShell } from "./_shell/app-shell";
import { Viewer } from "./_shell/viewer";

// The signed-in area's layout: the app shell around every page
// (docs/design-system.md → App shell). The shell is static; only the viewer
// reads the login session, inside its own Suspense boundary, and every page
// still checks the login session itself, inside its own Suspense boundary
// (ADR-0003).
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <AppShell
      viewer={
        <Suspense fallback={null}>
          <Viewer />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  );
}
