import type { Metadata } from "next";

export const metadata: Metadata = { title: "HiveMind" };

// The public landing page. `apps/web/src/proxy.ts` rewrites a signed-out
// visit to `/` here, so visitors usually see it at `/`.
export default function WelcomePage() {
  return (
    <main>
      <h1>HiveMind</h1>
    </main>
  );
}
