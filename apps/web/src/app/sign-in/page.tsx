import type { Metadata } from "next";
import { Suspense } from "react";
import { RETURN_TO_PARAM, safeReturnPath } from "../../lib/return-path";
import { SignInButton } from "./sign-in-button";

export const metadata: Metadata = { title: "Sign in · hive-mind" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <main>
      <h1>Sign in to hive-mind</h1>
      {/* The return path is request data, so it is read inside a Suspense
          boundary; the fallback signs in to the home page. */}
      <Suspense fallback={<SignInButton callbackURL="/" />}>
        <SignInWithReturnPath searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function SignInWithReturnPath({
  searchParams,
}: {
  searchParams: PageProps<"/sign-in">["searchParams"];
}) {
  const returnTo = (await searchParams)[RETURN_TO_PARAM];
  // better-auth checks the callback URL against trusted origins as well; a
  // same-origin relative path passes both checks.
  return <SignInButton callbackURL={safeReturnPath(returnTo) ?? "/"} />;
}
