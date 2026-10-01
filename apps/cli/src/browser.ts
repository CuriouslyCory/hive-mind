import { spawn } from "node:child_process";

/**
 * Best-effort browser launch for `login` in a terminal. The URL is passed as
 * one argv element (never through a shell), the opener's output is discarded,
 * and any failure (no opener installed, no display) resolves false so the
 * caller falls back to the printed URL. Never used without a TTY.
 */
export function openBrowser(url: string, platform: NodeJS.Platform): Promise<boolean> {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Promise.resolve(false);
  }
  const opener = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (!opener) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(opener, [parsed.href], { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
