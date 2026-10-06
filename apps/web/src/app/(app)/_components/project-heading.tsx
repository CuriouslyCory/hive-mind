import type { ProjectHeader } from "../../../server/dashboard/queries";
import { Breadcrumb, type Crumb } from "../_shell/breadcrumb";
import { formatUtc } from "./format";
import { projectPath } from "./paths";

/**
 * A Project page's heading: the breadcrumb from the Dashboard through the
 * Project to the page, the page's `<h1>`, and its context (the Organization,
 * and the database time the page's data was read at). On the overview the
 * Project is the current page and its name the heading; a Plan, Session or
 * ADR page passes `trail` (the crumbs after the Project, the last one
 * current) and its own `title`.
 */
export function ProjectHeading({
  project,
  asOf,
  trail,
  title,
}: {
  project: ProjectHeader;
  asOf: Date;
  trail?: readonly Crumb[];
  title?: string;
}) {
  const crumbs: Crumb[] = [{ label: "Dashboard", href: "/" }];
  if (trail) crumbs.push({ label: project.name, href: projectPath(project.id) }, ...trail);
  else crumbs.push({ label: project.name });
  return (
    <header className="project-heading">
      <Breadcrumb items={crumbs} />
      <h1>{title ?? project.name}</h1>
      <p className="project-meta">
        {trail
          ? `In ${project.organizationName}`
          : `${project.organizationName} · ${project.slug}${project.repoUrl ? ` · ${project.repoUrl}` : ""}`}
        {" · As of "}
        <time dateTime={asOf.toISOString()}>{formatUtc(asOf)}</time>
      </p>
    </header>
  );
}
