import Link from "next/link";

// The layout of one Project's pages. It reads no request data (not even
// `params`), so it stays in the static shell; each page authorizes its own
// reads. The Project's live-update provider mounts here, around `children`:
// it receives the `params` promise for the Project id and takes its starting
// cursor from the page it wraps (`feedCursor`), so it stays mounted, with its
// subscription and cursor, while the User moves between the Project's pages.
export default function ProjectLayout({ children }: LayoutProps<"/projects/[projectId]">) {
  return (
    <>
      <nav aria-label="Breadcrumb">
        <Link href="/">All Projects</Link>
      </nav>
      {children}
    </>
  );
}
