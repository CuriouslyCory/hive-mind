"use server";

import { headers } from "next/headers";
import { auth } from "../../server/auth";
import { type DecisionResult, decideDeviceRequest } from "../../server/device-approval";

/**
 * The Approve and Deny buttons on `/device`. A server action is a public POST
 * endpoint, so `decideDeviceRequest` checks the origin and the cookie login
 * session itself rather than trusting that the page was rendered.
 */
export async function decideDeviceAuthorization(
  _previous: DecisionResult | null,
  formData: FormData,
): Promise<DecisionResult> {
  const decision = formData.get("decision");
  if (decision !== "approve" && decision !== "deny") {
    return { kind: "error", reason: "invalid" };
  }
  return decideDeviceRequest(auth, await headers(), formData.get("user_code"), decision);
}
