import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "hive-mind",
  description:
    "A shared, live view of project state for coding agents working on the same codebase.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
