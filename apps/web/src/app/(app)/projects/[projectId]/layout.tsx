import Link from "next/link";
import { LiveStatus } from "../../../../components/dashboard/live-status";
import {
  ProjectLiveContent,
  ProjectLiveUpdates,
} from "../../../../components/dashboard/project-live-updates";

// The layout of one Project's pages. It reads no request data (not even
// `params`), so it stays in the static shell; each page authorizes its own
// reads. The Project's live-update provider mounts here, so one subscription
// and its cursor survive moving between the Project's pages. A layout does
// not re-render when its page changes, so the starting cursor cannot come
// from here: each page registers the fence of its own snapshot with
// `ProjectLivePage` (apps/web/src/lib/project-live-registry.ts).
export default function ProjectLayout({ children }: LayoutProps<"/projects/[projectId]">) {
  return (
    <ProjectLiveUpdates>
      <nav aria-label="Breadcrumb">
        <Link href="/">All Projects</Link>
      </nav>
      <LiveStatus />
      <ProjectLiveContent>{children}</ProjectLiveContent>
    </ProjectLiveUpdates>
  );
}
