import type { CommandDefinition } from "../command.ts";
import {
  createDeviceTransport,
  formatUserCode,
  pollForToken,
  requestDeviceCode,
} from "../device-login.ts";
import { isCliError } from "../errors.ts";
import { hivemindTokenSet, STORE_DESCRIPTIONS } from "./shared.ts";

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
    "If HIVEMIND_TOKEN is set, the login is still stored, but HIVEMIND_TOKEN keeps",
    "taking precedence until you unset it.",
  ].join("\n"),
  examples: ["hivemind login", "hivemind login --server http://localhost:3000"],
  async run(context) {
    const { origin } = context.origin();
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

    const saved = await context.credentials().save(origin, accessToken);
    for (const warning of saved.warnings) context.report.warn(warning);

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
