import Link from "next/link";
import { Suspense } from "react";
import { cursorParam, loadProjectList } from "../../server/dashboard/queries";
import { getDb } from "../../server/db";
import { requireFreshLoginSession } from "../../server/login-session";
import { Pager } from "./_components/pager";
import { projectPath, withParams } from "./_components/paths";
import { SignOutButton } from "./sign-out-button";

// `/`: the Projects of every Organization the User is a Member of (issue
// #11). The heading is the static shell; the login session and the list are
// read at request time, inside Suspense.
export default function HomePage({ searchParams }: PageProps<"/">) {
  return (
    <main>
      <h1>hive-mind</h1>
      <Suspense fallback={<p role="status">Loading your Projects…</p>}>
        <Projects searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Projects({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const cursor = cursorParam((await searchParams).cursor);
  const returnPath = withParams("/", { cursor });
  const { user } = await requireFreshLoginSession(returnPath);
  const { data: page } = await loadProjectList(getDb(), user.id, cursor);

  return (
    <>
      <p>
        Signed in as {user.name}. <SignOutButton />
      </p>
      <h2>Projects</h2>
      {page.items.length === 0 && cursor === undefined ? (
        <p>
          You have no Projects yet. In your repository, run{" "}
          <code>hivemind init --name &apos;My project&apos; --slug my-project</code> to create one
          and link the repository to it (see{" "}
          <a href="https://github.com/CuriouslyCory/hive-mind/blob/main/docs/cli.md#hivemind-init">
            the CLI guide
          </a>
          ).
        </p>
      ) : (
        <ul>
          {page.items.map((project) => (
            <li key={project.id}>
              <Link href={projectPath(project.id)}>{project.name}</Link>{" "}
              <span className="muted">
                ({project.organizationName}, {project.slug})
              </span>
            </li>
          ))}
        </ul>
      )}
      <Pager
        path="/"
        current={{ cursor }}
        param="cursor"
        nextCursor={page.nextCursor}
        label="Projects"
      />
    </>
  );
}
