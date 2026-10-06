import "../../_components/project.css";
import { LiveStatus } from "../../../../components/dashboard/live-status";
import {
  ProjectLiveContent,
  ProjectLiveUpdates,
} from "../../../../components/dashboard/project-live-updates";

// The layout of one Project's pages, inside the app shell. It reads no
// request data (not even `params`), so it stays in the static shell; each
// page authorizes its own reads and renders its own breadcrumb. The
// Project's live-update provider mounts here, so one subscription and its
// cursor survive moving between the Project's pages. A layout does not
// re-render when its page changes, so the starting cursor cannot come from
// here: each page registers the fence of its own snapshot with
// `ProjectLivePage` (apps/web/src/lib/project-live-registry.ts). Every rule
// of project.css is scoped under .hm-project.
export default function ProjectLayout({ children }: LayoutProps<"/projects/[projectId]">) {
  return (
    <ProjectLiveUpdates>
      <div className="hm-project">
        <LiveStatus />
        <ProjectLiveContent>{children}</ProjectLiveContent>
      </div>
    </ProjectLiveUpdates>
  );
}
