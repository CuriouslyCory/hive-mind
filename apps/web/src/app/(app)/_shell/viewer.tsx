import { buttonClassName } from "../../../design-system/button";
import { Hexagon } from "../../../design-system/icon";
import { getFreshLoginSession } from "../../../server/login-session";
import { SignOutButton } from "../sign-out-button";

/**
 * The signed-in User in the app shell's top bar, with Sign out. It reads the
 * login session, so the layout renders it inside Suspense. The same fresh
 * read as the page's own check, so React's per-request cache answers both
 * with one lookup. Signed out it renders nothing: the page redirects.
 */
export async function Viewer() {
  const signedIn = await getFreshLoginSession();
  return signedIn ? <ViewerView name={signedIn.user.name} /> : null;
}

/** `Viewer` for a name: its initial in a hexagon, the name, and Sign out. */
export function ViewerView({ name }: { name: string }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <>
      <span className="app-viewer">
        <span aria-hidden="true">
          <Hexagon size={28} tone="hive">
            <span className="app-viewer-initial">{initial}</span>
          </Hexagon>
        </span>
        <span className="app-viewer-name">{name}</span>
      </span>
      <SignOutButton className={buttonClassName({ variant: "quiet", size: "sm" })} />
    </>
  );
}
