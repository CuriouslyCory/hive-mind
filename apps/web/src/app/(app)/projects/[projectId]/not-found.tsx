import Link from "next/link";

// One answer for a Project, Plan or Session that does not exist and for one
// the User cannot read, so the page never reveals which it is.
export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p>This page does not exist, or you do not have access to it.</p>
      <p>
        <Link href="/">Back to your Projects</Link>
      </p>
    </main>
  );
}
