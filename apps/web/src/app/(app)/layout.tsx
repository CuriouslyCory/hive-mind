import "./dashboard.css";

// The signed-in area's shell: styles only. It reads no request data, so it
// stays in the static shell; every page checks the login session itself,
// inside its own Suspense boundary (ADR-0003).
export default function AppLayout({ children }: LayoutProps<"/">) {
  return children;
}
