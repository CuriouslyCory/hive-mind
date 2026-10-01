import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { auth } from "../../server/auth";
import { formatUserCode, viewDeviceRequest } from "../../server/device-approval";
import { requireLoginSession } from "../../server/login-session";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Sign in the CLI · hive-mind" };

/**
 * The device flow's verification URI. `hivemind login` prints this page's
 * address and a user code, or opens `/device?user_code=...`. The page shows
 * the request to the signed-in User; only its Approve button signs the CLI in.
 */
export default function DevicePage({ searchParams }: PageProps<"/device">) {
  return (
    <main>
      <h1>Sign in the hive-mind CLI</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <DeviceRequest searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function DeviceRequest({
  searchParams,
}: {
  searchParams: PageProps<"/device">["searchParams"];
}) {
  const param = (await searchParams).user_code;
  const rawUserCode = Array.isArray(param) ? param[0] : param;
  const { user } = await requireLoginSession(
    rawUserCode === undefined
      ? "/device"
      : `/device?${new URLSearchParams({ user_code: rawUserCode })}`,
  );
  if (rawUserCode === undefined || rawUserCode === "") return <UserCodeForm />;

  const request = await viewDeviceRequest(auth, await headers(), rawUserCode);
  switch (request.kind) {
    case "review":
      return (
        <>
          <p>A hive-mind command-line tool is asking to sign in as you.</p>
          <p>
            Code: <strong>{formatUserCode(request.userCode)}</strong>
          </p>
          <p>
            Check that this is the code shown in your terminal. Approve only if you ran{" "}
            <code>hivemind login</code> yourself, just now.
          </p>
          <p>
            Approving gives the CLI (client <code>{request.clientId}</code>) a login session as{" "}
            {user.name} ({user.email}). It can do anything you can do in hive-mind, in every
            organization you belong to, until it expires or you run <code>hivemind logout</code>.
          </p>
          <DecisionForm userCode={request.userCode} />
        </>
      );
    case "decided":
      return (
        <p role="status">
          {request.status === "approved"
            ? "This request was already approved. Return to your terminal."
            : "This request was denied."}
        </p>
      );
    case "unavailable":
      return <p role="alert">This code cannot be approved from this account.</p>;
    case "expired":
      return (
        <p role="alert">
          This code has expired. Run <code>hivemind login</code> again to get a new one.
        </p>
      );
    case "invalid":
      return (
        <>
          <p role="alert">That code was not found. Check the code shown in your terminal.</p>
          <UserCodeForm />
        </>
      );
  }
}

/**
 * Asks for the code the CLI printed. Submitting it only opens the request
 * (a GET to this page); approving it is a separate step.
 */
function UserCodeForm() {
  return (
    <form method="get" action="/device">
      <label>
        Code from your terminal{" "}
        <input
          name="user_code"
          required
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
      </label>{" "}
      <button type="submit">Continue</button>
    </form>
  );
}
