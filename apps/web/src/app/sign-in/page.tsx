import type { Metadata } from "next";
import { Suspense } from "react";
import { Button, LogoLockup } from "../../design-system";
import { RETURN_TO_PARAM, safeReturnPath } from "../../lib/return-path";
import { SiteHeader, SitePage } from "../../site";
// After the site import, which loads the design system's styles, so this
// page's rules come after them.
import "./sign-in.css";
import { SignInButton } from "./sign-in-button";

export const metadata: Metadata = { title: "Sign in · HiveMind" };

// Every style in sign-in.css is scoped under `.hm-sign-in`, because global
// stylesheets stay loaded after client navigation.
export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <SitePage
      className="hm-sign-in"
      mainId="sign-in"
      mainClassName="si-main"
      header={
        <SiteHeader>
          {/* Below 720px the label is "Back", so the top bar fits at 320px;
              the accessible name stays whole. */}
          <Button variant="quiet" href="/" aria-label="Back to HiveMind">
            <span>
              Back<span className="site-hide-sm"> to HiveMind</span>
            </span>
          </Button>
        </SiteHeader>
      }
    >
      <div className="si-card">
        <div className="si-intro">
          <div className="si-lockup-tile">
            {/* Decorative: the heading below names HiveMind. */}
            <LogoLockup decorative size={160} loading="eager" />
          </div>
          <div className="si-heading">
            <h1 className="hm-text-heading-md">Sign in to HiveMind</h1>
            <p className="si-muted">
              Use the GitHub account that has access to your repositories. The dashboard is
              read-only; nothing about your code changes.
            </p>
          </div>
        </div>
        <div className="si-actions">
          {/* The return path is request data, so it is read inside a Suspense
              boundary; the fallback signs in to the home page. */}
          <Suspense fallback={<SignInButton callbackURL="/" />}>
            <SignInWithReturnPath searchParams={searchParams} />
          </Suspense>
        </div>
        <p className="si-agent-note hm-text-small">
          Signing in an agent? Run <code className="si-chip hm-text-code-sm">hivemind login</code>{" "}
          in its terminal and approve the code it prints.
        </p>
      </div>
    </SitePage>
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
