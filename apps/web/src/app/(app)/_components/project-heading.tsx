import Link from "next/link";
import type { ProjectHeader } from "../../../server/dashboard/queries";
import { formatUtc } from "./format";
import { projectPath } from "./paths";

/**
 * A Project page's context: the Project and Organization names, and the
 * database time the page's data was read at. On the overview the name is
 * the page heading; on a Plan or Session page it links back to the overview.
 */
export function ProjectHeading({
  project,
  asOf,
  linked = false,
}: {
  project: ProjectHeader;
  asOf: Date;
  linked?: boolean;
}) {
  return (
    <header>
      {linked ? (
        <p>
          <Link href={projectPath(project.id)}>{project.name}</Link>{" "}
          <span className="muted">in {project.organizationName}</span>
        </p>
      ) : (
        <>
          <h1>{project.name}</h1>
          <p className="muted">
            {project.organizationName} · {project.slug}
            {project.repoUrl ? ` · ${project.repoUrl}` : ""}
          </p>
        </>
      )}
      <p className="muted">
        As of <time dateTime={asOf.toISOString()}>{formatUtc(asOf)}</time>
      </p>
    </header>
  );
}
