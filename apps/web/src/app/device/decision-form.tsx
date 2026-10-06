"use client";

import { useActionState } from "react";
import { Alert } from "../../design-system/alert";
import { Button } from "../../design-system/button";
import type { DecisionFailure } from "../../server/device-approval";
import { decideDeviceAuthorization } from "./actions";

const FAILURE_MESSAGES: Record<DecisionFailure, string> = {
  "cross-origin": "This request did not come from this site, so nothing was changed.",
  "signed-out": "You are signed out. Sign in again, then reopen the link from your terminal.",
  invalid: "That code was not found. Check the code shown in your terminal.",
  expired: "This code has expired. Run `hivemind login` again to get a new one.",
  "already-decided": "This request was already approved or denied.",
  "not-reviewed": "Reload this page to review the request, then decide.",
  "other-user": "This code cannot be approved from this account.",
};

/**
 * Approve and Deny for one reviewed device request. Both are submit buttons
 * of one form, so the browser POSTs the decision; nothing happens on render.
 */
export function DecisionForm({ userCode }: { userCode: string }) {
  const [result, decide, pending] = useActionState(decideDeviceAuthorization, null);

  if (result?.kind === "approved") {
    return (
      <Alert tone="success">
        Approved. Return to your terminal; the CLI is now signed in as you.
      </Alert>
    );
  }
  if (result?.kind === "denied") {
    return <Alert>Denied. The CLI was not signed in. You can close this page.</Alert>;
  }

  const finished =
    result?.kind === "error" &&
    (result.reason === "expired" || result.reason === "already-decided");
  return (
    <>
      {result?.kind === "error" && <Alert tone="danger">{FAILURE_MESSAGES[result.reason]}</Alert>}
      {!finished && (
        <form className="dv-decision" action={decide}>
          <input type="hidden" name="user_code" value={userCode} />
          <Button
            type="submit"
            variant="primary"
            name="decision"
            value="approve"
            disabled={pending}
          >
            Approve
          </Button>
          <Button type="submit" name="decision" value="deny" disabled={pending}>
            Deny
          </Button>
        </form>
      )}
    </>
  );
}
