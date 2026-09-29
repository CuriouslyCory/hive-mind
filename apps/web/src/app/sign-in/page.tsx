import type { Metadata } from "next";
import { SignInButton } from "./sign-in-button";

export const metadata: Metadata = { title: "Sign in · hive-mind" };

export default function SignInPage() {
  return (
    <main>
      <h1>Sign in to hive-mind</h1>
      <SignInButton />
    </main>
  );
}
