import type { CommandDefinition } from "../command.ts";
import type { SaveResult } from "../credentials/manager.ts";
import {
  createDeviceTransport,
  formatUserCode,
  pollForToken,
  requestDeviceCode,
} from "../device-login.ts";
import { isCliError } from "../errors.ts";
import { hivemindTokenSet, revokeLoginToken, STORE_DESCRIPTIONS } from "./shared.ts";

/** Per-request timeout while polling; a slow answer is retried with backoff, not fatal. */
const DEVICE_REQUEST_TIMEOUT_MS = 15_000;

export interface LoginData {
  origin: string;
  /** Where the login token is stored. The token itself is never printed. */
  credentialStore: "keychain" | "libsecret" | "file";
  /** The User the login belongs to, or null if `/me` could not be read afterwards. */
  user: { id: string; name: string; email: string } | null;
  /** HIVEMIND_TOKEN is set, so it (not this login) is what other commands use. */
  hivemindTokenSet: boolean;
}

export const login: CommandDefinition = {
  name: "login",
  summary: "Log in through the browser (device approval) and store the login",
  description: [
    "Starts a device login: prints a URL and a code on stderr, then waits while",
    "you approve the request in a browser where you are signed in to Hive Mind.",
    "In a terminal it also tries to open the browser; without one it only prints",
    "and waits, and never reads input. Ctrl+C cancels and stores nothing.",
    "",
    "The login is stored for this server only, in the macOS Keychain or Secret",
    "Service when available (interactive terminals only), otherwise in a private",
    "credentials.json file. The token is never printed.",
    "",
    "A login already stored for this server is replaced, and the server is asked",
    "to revoke it; if it cannot be read or revoked, a warning says so and the",
    "login still succeeds. If the new login cannot be stored, it is revoked and",
    "the previous one is left in place.",
    "",
    "Without a terminal, a login kept in the Keychain or Secret Service can be",
    "neither revoked nor deleted, so login refuses to replace it: it fails with",
    "TERMINAL_REQUIRED (exit 1) before contacting the server. Run 'hivemind",
    "logout' in a terminal first.",
    "",
    "If HIVEMIND_TOKEN is set to a non-empty value, the login is still stored,",
    "but HIVEMIND_TOKEN keeps taking precedence until you unset it. An empty",
    "HIVEMIND_TOKEN counts as unset.",
  ].join("\n"),
  examples: ["hivemind login", "hivemind login --server http://localhost:3000"],
  async run(context) {
    const { origin } = context.origin();
    // Before the device flow: refusing after the user approved in the browser
    // would waste the approval and mint a token only to revoke it.
    await context.credentials().checkReplaceable(origin);
    const tokenSet = hivemindTokenSet(context.env);
    if (tokenSet) {
      context.report.warn(
        "HIVEMIND_TOKEN is set: this login will be stored, but commands keep using HIVEMIND_TOKEN until you unset it.",
      );
    }

    const transport = createDeviceTransport(
      await context.originFetch({ credential: null, timeoutMs: DEVICE_REQUEST_TIMEOUT_MS }),
    );
    const authorization = await requestDeviceCode(transport, origin);
    const code = formatUserCode(authorization.userCode);
    context.report.info(`To log in to ${origin}, open this page in a browser:`);
    context.report.info(`  ${authorization.verificationUri}`);
    context.report.info(`and confirm the code ${code}.`);
    if (context.interactive) {
      const opened = await context.openUrl(
        authorization.verificationUriComplete ?? authorization.verificationUri,
      );
      context.report.info(
        opened ? "Opened your browser." : "Could not open a browser; open the page yourself.",
      );
    }
    const minutes = Math.max(1, Math.round(authorization.expiresInMs / 60_000));
    context.report.info(
      `Waiting for approval (the code expires in ${minutes} min; Ctrl+C cancels)...`,
    );

    const { accessToken } = await pollForToken({
      transport,
      clock: context.clock,
      signal: context.signal,
      origin,
      authorization,
      onEvent(event) {
        if (event.type === "slow_down") {
          context.report.info(
            `The server asked to poll less often; now every ${event.intervalMs / 1000} s.`,
          );
        } else {
          context.report.warn(
            `${event.reason} Still waiting; next attempt in ${Math.round(event.waitMs / 1000)} s.`,
          );
        }
      },
    });

    // Read the login being replaced before `save` overwrites it. Best effort:
    // one this run cannot read (a broken entry, a failing keyring) is replaced
    // without being revoked, and the warning says so.
    const previous = await context
      .credentials()
      .readStored(origin)
      .catch((error: unknown) => {
        const detail = isCliError(error) ? error.message : String(error);
        context.report.warn(
          `Could not read the login being replaced for ${origin} (${detail}); it was not revoked on the server and stays valid until it expires.`,
        );
        return null;
      });
    let saved: SaveResult;
    try {
      saved = await context.credentials().save(origin, accessToken);
    } catch (error) {
      // Not stored anywhere, so nothing could ever use or revoke it later.
      const failure = await revokeLoginToken(context, {
        origin,
        token: accessToken,
        source: "file",
      });
      if (failure !== null) {
        context.report.warn(
          `The new login could not be stored and was not revoked on the server (${failure}); it stays valid until it expires.`,
        );
      }
      throw error;
    }
    for (const warning of saved.warnings) context.report.warn(warning);
    if (previous && previous.token !== accessToken) {
      // Only after the new login is stored, so a failure here never leaves the
      // user logged out; the old token would otherwise stay valid until it expires.
      const failure = await revokeLoginToken(context, previous);
      if (failure !== null) {
        context.report.warn(
          `The previous login for ${origin} was replaced but not revoked on the server (${failure}); it stays valid until it expires.`,
        );
      }
    }

    let user: LoginData["user"] = null;
    try {
      const api = await context.api({
        credential: { origin, token: accessToken, source: saved.store },
      });
      const me = await api.me();
      if (me.kind === "user") user = { id: me.user.id, name: me.user.name, email: me.user.email };
    } catch (error) {
      // The login is stored and valid as far as the device flow is concerned;
      // failing to show the name is not worth failing the command.
      const detail = isCliError(error) ? error.message : String(error);
      context.report.warn(`Logged in, but could not load your profile: ${detail}`);
    }

    const data: LoginData = {
      origin,
      credentialStore: saved.store,
      user,
      hivemindTokenSet: tokenSet,
    };
    const who = user ? ` as ${user.name} <${user.email}>` : "";
    const human = [
      `Logged in to ${origin}${who}.`,
      `The login is stored in ${STORE_DESCRIPTIONS[saved.store]}.`,
    ];
    if (tokenSet) human.push("HIVEMIND_TOKEN is set and still takes precedence.");
    return { data, human };
  },
};
