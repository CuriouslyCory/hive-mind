import { join } from "node:path";
import {
  ADR_STATES,
  ADR_STATUSES,
  type AdrStatus,
  adrContentSha256,
  adrFileName,
  formatAdrNumber,
  isAdrDirectory,
  isAdrSlug,
  MAX_ADR_CONTENT_BATCH_FILES,
  MAX_ADR_FILE_BYTES,
  MAX_ADR_NUMBER,
  MAX_ADR_UPLOAD_BODY_BYTES,
  MAX_PAGE_LIMIT,
  MIN_ADR_NUMBER,
  newAdrTitleSchema,
  parseAdrFile,
  parseAdrIdentifier,
  renderAdrTemplate,
  rewriteAdrFrontmatter,
  slugifyAdrTitle,
  validateAdrSet,
} from "@hivemind/contract";
import {
  type AdrFileProblem,
  type AdrInput,
  type AdrLocation,
  type AdrNotice,
  type AdrSource,
  adrInvalidError,
  boundedWarnings,
  checkAdrSet,
  duplicateNumbersError,
  ensureAdrDirectory,
  type FileReplacement,
  listLocalAdrFiles,
  locateAdrs,
  numberOfFileName,
  type ParsedAdrSource,
  type PathDisplay,
  pathDisplay,
  readLocalAdr,
  replaceFiles,
  sourceIn,
} from "../adr-files.ts";
import type {
  ApiAdr,
  ApiAdrChange,
  ApiAdrSummary,
  ApiAdrSyncState,
  HivemindApi,
} from "../client.ts";
import type { CommandContext, CommandDefinition, OptionSpec } from "../command.ts";
import {
  CLI_ERROR_CODES,
  CliError,
  isCliError,
  isUncertainOutcome,
  usageError,
} from "../errors.ts";
import { createFileExclusive, readFileNoFollow } from "../fs-safe.ts";
import {
  gitHasCommit,
  gitIsAncestor,
  gitListTree,
  gitMetadata,
  gitReadBlob,
  gitResolveCommit,
} from "../git.ts";
import {
  CURSOR_OPTION,
  choiceOf,
  createWithRecovery,
  creationId,
  idOption,
  LIMIT_OPTION,
  optionalSessionOf,
  PROJECT_OPTION,
  pageLines,
  pageOf,
  projectOf,
  SESSION_OPTION,
  stringOption,
} from "./coordination.ts";

/**
 * ADRs (issue #19, ADR-0001, ADR-0017). The repository's `docs/adr/` files
 * are the source of truth. hive-mind hands out ADR numbers (`adr new`) and
 * keeps a read-only copy of the files as of one commit (`adr sync`, read by
 * `adr list` and `adr show`). `adr status` and `adr supersede` edit local
 * files only and make no server call: the copy learns about a change when it
 * is merged and synced.
 */

/** What `adr sync` reads unless `--ref` says otherwise: the remote's default branch, as last fetched. */
export const DEFAULT_ADR_REF = "refs/remotes/origin/HEAD";

/** Statuses `adr status` sets; `superseded` is `adr supersede`'s. */
const SETTABLE_STATUSES = ["proposed", "accepted", "deprecated"] as const;

const ADR_ARG = {
  name: "adr",
  description: "ADR number: ADR-0015, 0015 or 15",
  required: true,
} as const;

const ATTRIBUTION_OPTION = {
  ...SESSION_OPTION,
  description: "Attribute the change to this Session (default: HIVEMIND_SESSION, if set)",
} as const satisfies OptionSpec;

const TITLE_RULE =
  "--title must be 1 to 200 characters on one line, without leading or trailing spaces or a closing #.";

/** `ADR-0015`; a number outside 1-9999 from a newer server is shown as it is. */
function adrName(number: number): string {
  return Number.isInteger(number) && number >= MIN_ADR_NUMBER && number <= MAX_ADR_NUMBER
    ? formatAdrNumber(number)
    : `ADR-${number}`;
}

function adrNumberOf(value: string, what: string): number {
  const number = parseAdrIdentifier(value);
  if (number === null) {
    throw usageError(`${what} must be an ADR number such as ADR-0015, 0015 or 15.`);
  }
  return number;
}

const short = (sha: string) => sha.slice(0, 7);

function syncFooter(lastSync: ApiAdrSyncState | null): string {
  return lastSync === null
    ? "No ADRs synced yet. Run 'hivemind adr sync' on the default branch."
    : `As of commit ${short(lastSync.commitSha)}, synced ${lastSync.syncedAt}.`;
}

function adrLine(adr: ApiAdrSummary): string {
  const taken =
    adr.reservationTaken && adr.reservation
      ? `  (reserved for '${adr.reservation.title}': needs a new number)`
      : "";
  return `${adrName(adr.number)}  ${adr.state}  ${adr.status ?? "-"}  ${adr.title}${taken}`;
}

/** The working tree's ADR directory for the local-only commands; USAGE_ERROR when none applies. */
async function localAdrs(context: CommandContext): Promise<AdrLocation> {
  const location = await locateAdrs(context, { binding: false });
  if (location === null) {
    throw usageError(
      "No ADR directory: this directory is not in a git repository and has no .hivemind.json.",
      "Run the command inside the repository whose docs/adr/ you mean.",
    );
  }
  return location;
}

/** The one local file with `number`: NOT_FOUND without one, CONFLICT with several. */
async function oneLocalFile(
  location: AdrLocation,
  number: number,
  display: PathDisplay,
): Promise<AdrSource> {
  const files = (await listLocalAdrFiles(location)).filter(
    (file) => numberOfFileName(file.fileName) === number,
  );
  const [file] = files;
  if (file === undefined) {
    throw new CliError(
      "NOT_FOUND",
      `No local file has ${adrName(number)} in ${display(location.dir)}/.`,
    );
  }
  if (files.length > 1) {
    throw new CliError(
      "CONFLICT",
      `More than one local file has ${adrName(number)}: ${files.map((each) => display(each.absolute)).join(", ")}.`,
      { hint: "Keep one file per ADR number, then run the command again." },
    );
  }
  return file;
}

function parseOrFail(
  context: CommandContext,
  source: AdrSource,
  bytes: Uint8Array,
  display: PathDisplay,
) {
  const parsed = parseAdrFile(source.fileName, bytes);
  if (!parsed.ok) {
    throw adrInvalidError(
      context,
      `${display(source.absolute)} is not a valid ADR`,
      parsed.errors.map((error) => ({ source, ...error })),
      display,
      "Fix the file, then run the command again.",
    );
  }
  return parsed.adr;
}

// ---------------------------------------------------------------------------
// adr new

/**
 * The highest ADR number in the working tree's ADR directory and in the
 * default branch's tree (when this clone has `origin/HEAD`), from file names
 * only; 0 for none. The server starts numbering above it.
 */
async function adrFloor(context: CommandContext, location: AdrLocation): Promise<number> {
  let floor = 0;
  for (const file of await listLocalAdrFiles(location)) {
    floor = Math.max(floor, numberOfFileName(file.fileName) ?? 0);
  }
  if (location.root === null) return floor;
  const head = await gitResolveCommit(location.root, context.env, DEFAULT_ADR_REF);
  if (head === null) return floor;
  const tree = await gitListTree(location.root, context.env, head, location.directory);
  if (!tree.ok) return floor;
  for (const entry of tree.entries) {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    floor = Math.max(floor, numberOfFileName(name) ?? 0);
  }
  return floor;
}

export const adrNew: CommandDefinition = {
  name: "adr new",
  summary: "Reserve the next ADR number and write the ADR template",
  description: [
    "Reserves the Project's next ADR number with hive-mind, then writes",
    "docs/adr/NNNN-<slug>.md (beside .hivemind.json) from ADR-0001's template,",
    "with status proposed and today's date, and prints its path. Numbers are",
    "never handed out twice, so two agents never write the same number; there",
    "is no offline fallback. An existing identical file is left as it is; a",
    "different file is never overwritten (CONFLICT, exit 2).",
    "",
    "The reservation's id is generated once per run. If the answer is lost,",
    "check 'hivemind adr list --state reserved' and retry only with --id <id>,",
    "which returns the same number instead of reserving another.",
  ].join("\n"),
  options: {
    title: { type: "string", valueName: "title", description: "ADR title (required)" },
    slug: {
      type: "string",
      valueName: "slug",
      description: "File name slug (default: from the title), e.g. adr-sync",
    },
    id: idOption("ADR reservation"),
    session: ATTRIBUTION_OPTION,
  },
  examples: [
    'hivemind adr new --title "Use keyset pages for ADR lists"',
    'hivemind adr new --title "Cache ADR pages" --slug cache-adr-pages --json',
  ],
  async run(context) {
    const title = stringOption(context, "title");
    if (title === undefined) throw usageError(`--title is required. ${TITLE_RULE}`);
    if (!newAdrTitleSchema.safeParse(title).success) throw usageError(TITLE_RULE);
    const slugFlag = stringOption(context, "slug");
    if (slugFlag !== undefined && !isAdrSlug(slugFlag)) {
      throw usageError(
        "--slug must be lowercase letters and digits joined by single hyphens, at most 100 characters.",
      );
    }
    const slug = slugFlag ?? slugifyAdrTitle(title);
    if (slug === null) {
      throw usageError(
        "The title has no letters or digits a file name slug can be made from.",
        "Pass --slug, e.g. --slug adr-sync.",
      );
    }
    const adrId = creationId(context);
    const sessionId = optionalSessionOf(context);
    const location = (await locateAdrs(context, { binding: true })) as AdrLocation;
    const projectId = location.projectId as string;
    const floor = await adrFloor(context, location);
    const { branch } = await gitMetadata(context.cwd, context.env);
    const api = await context.api();
    const result = await createWithRecovery(
      context,
      { what: "ADR reservation", id: adrId, inspect: "hivemind adr list --state reserved" },
      () =>
        api.reserveAdr(projectId, {
          adrId,
          title,
          slug,
          floor,
          ...(branch === null ? {} : { gitBranch: branch }),
          sessionId,
        }),
    );
    const { adr } = result;
    const name = adrName(adr.number);
    context.report.info(
      `${result.created ? "Reserved" : "Found existing reservation"} ${name} (${adrId}).`,
    );

    // The file is written from the reservation, which a replay returns as it
    // was first made.
    const reservedTitle = adr.reservation?.title ?? title;
    const reservedSlug = adr.reservation?.slug ?? slug;
    let fileName: string;
    try {
      fileName = adrFileName(adr.number, reservedSlug);
    } catch {
      throw new CliError(
        CLI_ERROR_CODES.invalidResponse,
        `The server reserved ${name} as '${reservedSlug}', which is not an ADR file name.`,
      );
    }
    const template = renderAdrTemplate({ title: reservedTitle, date: context.clock.today() });
    if (!template.ok) {
      throw new CliError(
        CLI_ERROR_CODES.invalidResponse,
        `The server reserved ${name} with a title the ADR template cannot hold: ${template.errors[0]?.message ?? ""}`,
      );
    }
    const source = sourceIn(location, fileName);
    const display = await pathDisplay(context.cwd);
    const target = display(source.absolute);
    const others = (await listLocalAdrFiles(location)).filter(
      (file) => file.fileName !== fileName && numberOfFileName(file.fileName) === adr.number,
    );
    if (others.length > 0) {
      throw new CliError(
        "CONFLICT",
        `${name} is reserved, but ${others.map((file) => display(file.absolute)).join(", ")} already has that number and was left unchanged.`,
        { hint: `Renumber or move it aside, then rerun with --id ${adrId} to write ${target}.` },
      );
    }
    await ensureAdrDirectory(location);
    let created: boolean;
    try {
      created = await createFileExclusive(source.absolute, template.contents, 0o666);
    } catch (error) {
      throw new CliError(
        CLI_ERROR_CODES.io,
        `${name} is reserved, but ${target} could not be written: ${(error as Error).message}`,
        { hint: `Rerun with --id ${adrId} to write it.`, cause: error },
      );
    }
    if (!created) {
      const existing = await readFileNoFollow(source.absolute, {
        maxBytes: MAX_ADR_FILE_BYTES,
      }).catch(() => null);
      if (existing === null || !existing.equals(Buffer.from(template.contents, "utf8"))) {
        throw new CliError(
          "CONFLICT",
          `${name} is reserved, but ${target} already exists with different content and was left unchanged.`,
          { hint: `Move it aside and rerun with --id ${adrId} to write the template.` },
        );
      }
    }
    return {
      data: { ...result, file: { path: source.path, status: created ? "created" : "unchanged" } },
      human: [target],
    };
  },
};

// ---------------------------------------------------------------------------
// adr list / adr show

export const adrList: CommandDefinition = {
  name: "adr list",
  summary: "List a Project's ADRs and reservations, highest number first (one page)",
  description: [
    "Reads hive-mind's copy, which is only as current as the last ADR sync; the",
    "last line names that commit. state is where a number is in the copy",
    "(reserved, published, removed), not the ADR's status.",
  ].join("\n"),
  options: {
    status: {
      type: "string",
      valueName: "status",
      description: `Only ADRs with this status: ${ADR_STATUSES.join(", ")}`,
    },
    state: {
      type: "string",
      valueName: "state",
      description: `Only ADRs in this state: ${ADR_STATES.join(", ")}`,
    },
    limit: LIMIT_OPTION,
    cursor: CURSOR_OPTION,
    project: PROJECT_OPTION,
  },
  examples: ["hivemind adr list --status accepted", "hivemind adr list --state reserved --json"],
  async run(context) {
    const status = stringOption(context, "status");
    const state = stringOption(context, "state");
    const input = {
      ...pageOf(context),
      ...(status === undefined ? {} : { status: choiceOf(status, ADR_STATUSES, "--status") }),
      ...(state === undefined ? {} : { state: choiceOf(state, ADR_STATES, "--state") }),
    };
    const projectId = await projectOf(context);
    const page = await (await context.api()).listAdrs(projectId, input);
    return {
      data: page,
      human: [...pageLines(page, adrLine, "No ADRs."), syncFooter(page.lastSync)],
    };
  },
};

type LocalMatch =
  | { match: "same" | "differs"; path: string; absolute: string }
  | { match: "missing" | "ambiguous"; path: null; absolute: null };

/** How the working tree's file for `adr` compares with the copy; null when no ADR directory applies. */
async function localMatch(context: CommandContext, adr: ApiAdr): Promise<LocalMatch | null> {
  let location: AdrLocation | null;
  try {
    location = await locateAdrs(context, { binding: false });
  } catch {
    // An unusable .hivemind.json does not stop reading the copy (--project).
    return null;
  }
  if (location === null) return null;
  const files = (await listLocalAdrFiles(location)).filter(
    (file) => numberOfFileName(file.fileName) === adr.number,
  );
  const [file] = files;
  if (file === undefined) return { match: "missing", path: null, absolute: null };
  if (files.length > 1) return { match: "ambiguous", path: null, absolute: null };
  const bytes = await readLocalAdr(file).catch(() => null);
  const same =
    bytes !== null &&
    adr.contentSha256 !== null &&
    file.path === adr.path &&
    (await adrContentSha256(bytes)) === adr.contentSha256;
  return { match: same ? "same" : "differs", path: file.path, absolute: file.absolute };
}

function adrDetailLines(adr: ApiAdr): string[] {
  const facts = [
    `state ${adr.state}`,
    ...(adr.status === null ? [] : [`status ${adr.status}`]),
    ...(adr.date === null ? [] : [`date ${adr.date}`]),
    ...(adr.path === null ? [] : [`path ${adr.path}`]),
  ];
  const chain = [
    ...(adr.supersedes.length === 0
      ? []
      : [`supersedes ${adr.supersedes.map(adrName).join(", ")}`]),
    ...(adr.supersededBy.length === 0
      ? []
      : [`superseded by ${adr.supersededBy.map(adrName).join(", ")}`]),
  ];
  const reservation = adr.reservation;
  return [
    `${adrName(adr.number)}  ${adr.title}`,
    facts.join("  "),
    ...(chain.length === 0 ? [] : [chain.join("  ")]),
    ...(reservation === null
      ? []
      : [
          `reserved as '${reservation.title}'${reservation.gitBranch ? ` on branch ${reservation.gitBranch}` : ""} at ${reservation.reservedAt}`,
        ]),
    ...(adr.reservationTaken && reservation
      ? [
          `This file took ${adrName(adr.number)}, which was reserved for '${reservation.title}'; the reserved ADR needs a new number.`,
        ]
      : []),
    ...adr.warnings.map((warning) => `warning: ${warning.code}: ${warning.message}`),
  ];
}

export const adrShow: CommandDefinition = {
  name: "adr show",
  summary: "Show an ADR from hive-mind's copy, and whether the local file differs",
  description: [
    "Prints the ADR as of the last ADR sync, with its supersedes chain and",
    "content, and says when the local file in docs/adr/ differs from that copy.",
  ].join("\n"),
  args: [ADR_ARG],
  options: { project: PROJECT_OPTION },
  examples: ["hivemind adr show ADR-0017", "hivemind adr show 17 --json"],
  async run(context) {
    const number = adrNumberOf(context.args[0] as string, "<adr>");
    const projectId = await projectOf(context);
    const { adr, lastSync } = await (await context.api()).getAdr(projectId, number);
    const local = await localMatch(context, adr);
    const display = await pathDisplay(context.cwd);
    const name = adrName(adr.number);
    const localLine =
      local === null || local.match === "same"
        ? []
        : local.match === "differs"
          ? [`The local file ${display(local.absolute)} differs from this copy.`]
          : local.match === "missing"
            ? [`No local file has ${name}.`]
            : [`More than one local file has ${name}.`];
    const content =
      adr.content === null ? [] : ["", ...adr.content.replace(/\r?\n$/, "").split(/\r?\n/)];
    return {
      data: {
        adr,
        lastSync,
        local: local === null ? null : { match: local.match, path: local.path },
      },
      human: [...adrDetailLines(adr), ...content, "", ...localLine, syncFooter(lastSync)],
    };
  },
};

// ---------------------------------------------------------------------------
// adr status / adr supersede (local files only)

export const adrStatus: CommandDefinition = {
  name: "adr status",
  summary: "Set a local ADR file's status and date (no server call)",
  description: [
    "Rewrites the status and date in the ADR's frontmatter and leaves the rest",
    "of the file byte for byte. Statuses: proposed, accepted, deprecated; use",
    "'hivemind adr supersede' for superseded. The current status is a no-op.",
    "Commit and merge the change, then run 'hivemind adr sync'.",
  ].join("\n"),
  args: [ADR_ARG, { name: "status", description: SETTABLE_STATUSES.join(", "), required: true }],
  examples: ["hivemind adr status ADR-0017 accepted", "hivemind adr status 9 deprecated --json"],
  async run(context) {
    const number = adrNumberOf(context.args[0] as string, "<adr>");
    const target = context.args[1] as string;
    if (target === "superseded") {
      throw usageError("Use 'hivemind adr supersede <old> --by <new>' to mark an ADR superseded.");
    }
    const status = choiceOf(target, SETTABLE_STATUSES, "<status>");
    const location = await localAdrs(context);
    const display = await pathDisplay(context.cwd);
    const file = await oneLocalFile(location, number, display);
    const bytes = await readLocalAdr(file);
    const current = parseOrFail(context, file, bytes, display);
    const name = adrName(number);
    let date = current.date;
    const changed = current.status !== status;
    if (changed) {
      const rewritten = rewriteAdrFrontmatter(bytes, { status, date: context.clock.today() });
      if (!rewritten.ok) {
        throw adrInvalidError(
          context,
          `${display(file.absolute)} cannot be rewritten`,
          rewritten.errors.map((error) => ({ source: file, ...error })),
          display,
        );
      }
      await replaceFiles([{ path: file.absolute, contents: rewritten.contents }]);
      date = rewritten.adr.date;
    }
    return {
      data: {
        number,
        path: file.path,
        status,
        previousStatus: current.status,
        date,
        changed,
      },
      human: [
        changed
          ? `${name} is now ${status}. Commit the change, merge it, then run 'hivemind adr sync'.`
          : `${name} is already ${status}.`,
      ],
    };
  },
};

export const adrSupersede: CommandDefinition = {
  name: "adr supersede",
  summary: "Mark a local ADR superseded by another (no server call)",
  description: [
    "Adds <old> to --by's supersedes list, then sets <old>'s status to",
    "superseded with today's date. Every local ADR is checked first: <new>",
    "must not be superseded itself, <old> must not be superseded by another",
    "ADR, and the change must not make a supersedes cycle (CONFLICT, exit 2).",
    "Both files are written before either is renamed into place, and a rerun",
    "finishes an interrupted run. Commit and merge both files, then run",
    "'hivemind adr sync'.",
  ].join("\n"),
  args: [
    { name: "old", description: "The ADR being superseded: ADR-0004, 0004 or 4", required: true },
  ],
  options: {
    by: {
      type: "string",
      valueName: "adr",
      description: "The ADR that supersedes <old> (required)",
    },
  },
  examples: [
    "hivemind adr supersede ADR-0004 --by ADR-0017",
    "hivemind adr supersede 4 --by 17 --json",
  ],
  async run(context) {
    const oldNumber = adrNumberOf(context.args[0] as string, "<old>");
    const by = stringOption(context, "by");
    if (by === undefined) throw usageError("--by is required: the ADR that supersedes <old>.");
    const newNumber = adrNumberOf(by, "--by");
    const oldName = adrName(oldNumber);
    const newName = adrName(newNumber);
    if (oldNumber === newNumber) throw usageError(`${oldName} cannot supersede itself.`);
    const location = await localAdrs(context);
    const display = await pathDisplay(context.cwd);

    // The graph check needs every ADR, so every file must parse.
    const inputs: AdrInput[] = [];
    for (const source of await listLocalAdrFiles(location)) {
      inputs.push({ source, bytes: await readLocalAdr(source) });
    }
    const check = await checkAdrSet(inputs);
    if (check.duplicates.length > 0) throw duplicateNumbersError(check.duplicates);
    if (check.problems.length > 0) {
      throw adrInvalidError(
        context,
        "Cannot check the supersedes graph",
        check.problems,
        display,
        "Fix the files, then run the command again.",
      );
    }
    const byNumber = new Map(check.adrs.map((item) => [item.adr.number, item]));
    const oldAdr = byNumber.get(oldNumber);
    const newAdr = byNumber.get(newNumber);
    for (const [found, name] of [
      [oldAdr, oldName],
      [newAdr, newName],
    ] as const) {
      if (found === undefined) {
        throw new CliError("NOT_FOUND", `No local file has ${name} in ${display(location.dir)}/.`);
      }
    }
    const older = oldAdr as ParsedAdrSource;
    const newer = newAdr as ParsedAdrSource;
    if (newer.adr.status === "superseded") {
      throw new CliError(
        "CONFLICT",
        `${newName} is superseded itself, so it cannot supersede ${oldName}.`,
      );
    }
    const otherSuccessors = check.adrs
      .filter((item) => item.adr.number !== newNumber && item.adr.supersedes.includes(oldNumber))
      .map((item) => adrName(item.adr.number));
    if (otherSuccessors.length > 0) {
      throw new CliError(
        "CONFLICT",
        `${oldName} is already superseded by ${otherSuccessors.join(", ")}.`,
      );
    }
    const listed = newer.adr.supersedes.includes(oldNumber);
    const supersedes = [...new Set([...newer.adr.supersedes, oldNumber])].sort((a, b) => a - b);
    if (!listed) {
      const wouldBe = validateAdrSet(
        check.adrs.map((item) => ({
          number: item.adr.number,
          path: item.source.path,
          status: item.adr.status,
          supersedes: item.adr.number === newNumber ? supersedes : item.adr.supersedes,
        })),
      );
      const cycle = wouldBe.warnings.find(
        (warning) => warning.code === "ADR_SUPERSEDES_CYCLE" && warning.number === newNumber,
      );
      if (cycle) {
        throw new CliError(
          "CONFLICT",
          `${newName} superseding ${oldName} would make a supersedes cycle: ${cycle.message}`,
        );
      }
    }

    // <new> first: a run that stops between the renames leaves <new> listing
    // <old>, which a rerun recognizes and completes by writing <old>.
    const writes: FileReplacement[] = [];
    if (!listed) {
      const rewritten = rewriteAdrFrontmatter(newer.bytes, { supersedes });
      if (!rewritten.ok) {
        throw adrInvalidError(
          context,
          `${display(newer.source.absolute)} cannot be rewritten`,
          rewritten.errors.map((error) => ({ source: newer.source, ...error })),
          display,
        );
      }
      writes.push({ path: newer.source.absolute, contents: rewritten.contents });
    }
    const oldChanged = older.adr.status !== "superseded";
    const today = context.clock.today();
    if (oldChanged) {
      const rewritten = rewriteAdrFrontmatter(older.bytes, { status: "superseded", date: today });
      if (!rewritten.ok) {
        throw adrInvalidError(
          context,
          `${display(older.source.absolute)} cannot be rewritten`,
          rewritten.errors.map((error) => ({ source: older.source, ...error })),
          display,
        );
      }
      writes.push({ path: older.source.absolute, contents: rewritten.contents });
    }
    if (writes.length > 0) {
      try {
        await replaceFiles(writes);
      } catch (error) {
        if (!isCliError(error)) throw error;
        throw new CliError(error.code, error.message, {
          hint: `Run 'hivemind adr supersede ${oldNumber} --by ${newNumber}' again to finish.`,
          cause: error,
        });
      }
    }
    const changed = writes.length > 0;
    return {
      data: {
        superseded: {
          number: oldNumber,
          path: older.source.path,
          status: "superseded" satisfies AdrStatus,
          previousStatus: older.adr.status,
          date: oldChanged ? today : older.adr.date,
          changed: oldChanged,
        },
        superseding: {
          number: newNumber,
          path: newer.source.path,
          supersedes,
          changed: !listed,
        },
        changed,
      },
      human: [
        changed
          ? `${oldName} is now superseded by ${newName}. Commit both files, merge them, then run 'hivemind adr sync'.`
          : `${oldName} is already superseded by ${newName}.`,
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// adr sync

type SyncOutcome = "synced" | "up_to_date" | "already_synced_past" | "dry_run" | "checked";

interface SyncData {
  outcome: SyncOutcome;
  ref: string | null;
  commitSha: string | null;
  baseCommitSha: string | null;
  forced: boolean;
  fileCount: number;
  uploadedFileCount: number;
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  changes: ApiAdrChange[];
  warnings: { items: AdrNotice[]; complete: boolean };
}

function noChanges(): Omit<
  SyncData,
  "outcome" | "ref" | "commitSha" | "baseCommitSha" | "forced" | "fileCount"
> {
  return {
    uploadedFileCount: 0,
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    changes: [],
    warnings: { items: [], complete: true },
  };
}

/** Blobs read from git at once. */
const READ_CONCURRENCY = 8;
/** Pages of 100 needed for 10,000 ADRs, with room; more is a server that never ends a list. */
const MAX_COPY_PAGES = 200;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The `.md` entries directly in the ADR directory of `commit`'s tree, read
 * with git (never the working tree). A blob over the size limit is reported
 * as ADR_TOO_LARGE without being read; a symlink or submodule is not a file.
 */
async function readCommitAdrs(
  context: CommandContext,
  location: AdrLocation,
  root: string,
  commit: string,
): Promise<AdrInput[]> {
  const tree = await gitListTree(root, context.env, commit, location.directory);
  if (!tree.ok) {
    throw new CliError(
      CLI_ERROR_CODES.io,
      `Cannot list ${location.directory} in commit ${short(commit)}: git ls-tree failed (${tree.failure}).`,
    );
  }
  const entries = tree.entries
    .filter((entry) => entry.path.endsWith(".md") && entry.type !== "tree")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return mapLimit(entries, READ_CONCURRENCY, async (entry): Promise<AdrInput> => {
    const source: AdrSource = {
      fileName: entry.path.slice(entry.path.lastIndexOf("/") + 1),
      path: entry.path,
      absolute: join(location.top, ...entry.path.split("/")),
    };
    if (entry.type !== "blob" || entry.mode === "120000") {
      return {
        source,
        bytes: null,
        unread: {
          code: "ADR_NOT_A_FILE",
          message: "This is a symbolic link or a submodule, not a regular file.",
        },
      };
    }
    if (entry.size !== null && entry.size > MAX_ADR_FILE_BYTES) {
      return {
        source,
        bytes: null,
        unread: {
          code: "ADR_TOO_LARGE",
          message: `The file is ${entry.size} bytes; an ADR may be at most ${MAX_ADR_FILE_BYTES} bytes.`,
        },
      };
    }
    const blob = await gitReadBlob(root, context.env, entry.oid, MAX_ADR_FILE_BYTES + 1);
    if (!blob.ok) {
      throw new CliError(
        CLI_ERROR_CODES.io,
        `Cannot read ${entry.path} from commit ${short(commit)}: git cat-file failed (${blob.failure}).`,
      );
    }
    return { source, bytes: blob.bytes };
  });
}

/** Every page of the copy: the base commit from the first page, and every item. */
async function readCopy(
  api: HivemindApi,
  projectId: string,
): Promise<{ base: string | null; items: ApiAdrSummary[] }> {
  let base: string | null | undefined;
  const items: ApiAdrSummary[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_COPY_PAGES; pages++) {
    const page = await api.listAdrs(projectId, {
      limit: MAX_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (base === undefined) base = page.lastSync?.commitSha ?? null;
    items.push(...page.items);
    if (page.nextCursor === null) return { base, items };
    cursor = page.nextCursor;
  }
  throw new CliError(
    CLI_ERROR_CODES.invalidResponse,
    `${api.origin} listed more than ${MAX_COPY_PAGES} pages of ADRs.`,
  );
}

/** What `syncAdrs` would report, computed from the copy's list (`--dry-run`). */
export function plannedChanges(
  adrs: readonly ParsedAdrSource[],
  items: readonly ApiAdrSummary[],
): Pick<SyncData, "added" | "updated" | "removed" | "unchanged" | "changes"> {
  const rows = new Map(items.map((item) => [item.number, item]));
  const numbers = new Set<number>();
  const changes: ApiAdrChange[] = [];
  let unchanged = 0;
  for (const item of adrs) {
    const { number, status } = item.adr;
    numbers.add(number);
    const path = item.source.path;
    const row = rows.get(number);
    if (row === undefined || row.state === "reserved") {
      changes.push({ number, change: "added", path, statusFrom: null, statusTo: status });
    } else if (row.state === "removed") {
      changes.push({ number, change: "restored", path, statusFrom: null, statusTo: status });
    } else if (row.contentSha256 !== item.sha256 || row.path !== path) {
      changes.push({ number, change: "updated", path, statusFrom: row.status, statusTo: status });
    } else unchanged += 1;
  }
  for (const row of items) {
    if (row.state === "published" && !numbers.has(row.number)) {
      changes.push({
        number: row.number,
        change: "removed",
        path: row.path ?? "",
        statusFrom: row.status,
        statusTo: null,
      });
    }
  }
  changes.sort((a, b) => a.number - b.number);
  const count = (...kinds: string[]) =>
    changes.filter((change) => kinds.includes(change.change)).length;
  return {
    added: count("added", "restored"),
    updated: count("updated"),
    removed: count("removed"),
    unchanged,
    changes,
  };
}

const utf8 = new TextEncoder();
// The upload is the file's exact text: a BOM stays, so the server hashes the
// same bytes the CLI did.
const exactUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Splits files into `uploadAdrContents` batches of at most 50 files whose
 * JSON body (`{"files":[...]}`) fits `MAX_ADR_UPLOAD_BODY_BYTES`. The parser
 * refuses the control characters JSON escapes with six bytes, so any valid
 * file fits a batch of its own.
 */
export function planAdrUploads<T extends { sha256: string; content: string }>(
  files: readonly T[],
  maxBytes: number = MAX_ADR_UPLOAD_BODY_BYTES,
): T[][] {
  const envelope = utf8.encode('{"files":[]}').byteLength;
  const batches: T[][] = [];
  let current: T[] = [];
  let size = envelope;
  for (const file of files) {
    const bytes = utf8.encode(
      JSON.stringify({ sha256: file.sha256, content: file.content }),
    ).byteLength;
    const added = (current.length === 0 ? 0 : 1) + bytes;
    if (
      current.length > 0 &&
      (current.length >= MAX_ADR_CONTENT_BATCH_FILES || size + added > maxBytes)
    ) {
      batches.push(current);
      current = [];
      size = envelope;
    }
    size += (current.length === 0 ? 0 : 1) + bytes;
    current.push(file);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function changeLine(change: ApiAdrChange): string {
  const statuses =
    change.change === "updated"
      ? change.statusFrom === change.statusTo
        ? ` (${change.statusTo ?? "-"})`
        : ` (${change.statusFrom ?? "-"} -> ${change.statusTo ?? "-"})`
      : ` (${(change.change === "removed" ? change.statusFrom : change.statusTo) ?? "-"})`;
  return `  ${adrName(change.number)} ${change.change}${statuses}`;
}

function noticeLine(notice: AdrNotice, top: string, display: PathDisplay): string {
  const where = notice.path === "" ? "" : ` ${display(join(top, ...notice.path.split("/")))}`;
  return `warning: ${adrName(notice.number)}${where}: ${notice.message}`;
}

function warningLines(data: SyncData, top: string, display: PathDisplay): string[] {
  const lines = data.warnings.items.map((notice) => noticeLine(notice, top, display));
  if (!data.warnings.complete) {
    lines.push("More warnings than shown: 'hivemind adr show <adr>' lists each ADR's own.");
  }
  return lines;
}

function countsText(data: SyncData): string {
  return `${data.added} added, ${data.updated} updated, ${data.removed} removed, ${data.unchanged} unchanged.`;
}

function commitText(data: SyncData): string {
  const was = data.baseCommitSha === null ? "(first sync)" : `(was ${short(data.baseCommitSha)})`;
  return `${short(data.commitSha ?? "")} ${was}${data.forced ? " (forced)" : ""}`;
}

/** `adr sync --check`: the working tree's ADR files, parsed locally; no server call, no credential. */
async function checkWorkingTree(context: CommandContext) {
  const location = await localAdrs(context);
  const display = await pathDisplay(context.cwd);
  const inputs: AdrInput[] = [];
  for (const source of await listLocalAdrFiles(location)) {
    inputs.push({ source, bytes: await readLocalAdr(source) });
  }
  const check = await checkAdrSet(inputs);
  if (check.duplicates.length > 0) throw duplicateNumbersError(check.duplicates);
  if (check.problems.length > 0) {
    throw adrInvalidError(context, "ADR check failed", check.problems, display);
  }
  const data: SyncData = {
    outcome: "checked",
    ref: null,
    commitSha: null,
    baseCommitSha: null,
    forced: false,
    fileCount: inputs.length,
    ...noChanges(),
    warnings: boundedWarnings(check.warnings),
  };
  const warnings = check.warnings.length;
  return {
    data,
    human: [
      `Checked ${inputs.length} ADR ${inputs.length === 1 ? "file" : "files"} in ${display(location.dir)}/: no errors, ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`,
      ...warningLines(data, location.top, display),
    ],
  };
}

/**
 * Where the copy's commit `base` stands relative to `commit` (issue #19
 * "Sync", ADR-0017): "sync" to go ahead, or an outcome that sends nothing.
 * `--force` skips every check except equality.
 */
async function compareWithCopy(
  context: CommandContext,
  root: string,
  base: string | null,
  commit: string,
  force: boolean,
): Promise<"sync" | "up_to_date" | "already_synced_past"> {
  if (base === commit) return "up_to_date";
  if (base === null || force) return "sync";
  if (!(await gitHasCommit(root, context.env, base))) {
    throw new CliError(
      "CONFLICT",
      `The ADR copy is at commit ${short(base)}, which this clone does not have.`,
      { hint: "Fetch the full history (CI: fetch-depth: 0), or pass --force after a force-push." },
    );
  }
  if (await gitIsAncestor(root, context.env, base, commit)) return "sync";
  if (await gitIsAncestor(root, context.env, commit, base)) return "already_synced_past";
  throw new CliError(
    "CONFLICT",
    `The ADR copy is at ${short(base)}, which is not an ancestor of ${short(commit)}.`,
    { hint: "If the default branch was force-pushed, rerun with --force." },
  );
}

export const adrSync: CommandDefinition = {
  name: "adr sync",
  summary: "Copy one commit's ADR files into hive-mind (default: origin's default branch)",
  description: [
    "Reads the ADR files of one commit with git, never the working tree, so",
    "unmerged branches and uncommitted edits are never synced. The default is",
    "refs/remotes/origin/HEAD as last fetched (adr sync does not fetch); in CI",
    "on a push to the default branch use --ref HEAD with fetch-depth: 0.",
    "",
    "Refuses the whole commit when two files share a number (CONFLICT, exit 2)",
    "or a file is invalid (ADR_INVALID, exit 1). A commit older than the copy's",
    "exits 0 with 'Already synced past this commit'; one that is not a",
    "descendant is CONFLICT unless --force (after a force-push). Uploads only",
    "content the copy lacks, then replaces the copy in one request. A rerun",
    "after a lost answer is safe.",
    "",
    "--check validates the working tree's docs/adr/ locally: no server call",
    "and no login needed, for pull request CI. --dry-run reads the copy and",
    "prints what would change without sending anything.",
  ].join("\n"),
  options: {
    ref: {
      type: "string",
      valueName: "rev",
      description: `The commit to read (default: ${DEFAULT_ADR_REF})`,
    },
    force: { type: "boolean", description: "Skip the ancestry check (after a force-push)" },
    check: { type: "boolean", description: "Only validate the working tree's ADR files" },
    "dry-run": { type: "boolean", description: "Show what would change; send nothing" },
    session: ATTRIBUTION_OPTION,
  },
  examples: [
    "hivemind adr sync",
    "hivemind adr sync --ref HEAD --json",
    "hivemind adr sync --check",
  ],
  async run(context) {
    const refFlag = stringOption(context, "ref");
    const force = context.options.force === true;
    const dryRun = context.options["dry-run"] === true;
    if (context.options.check === true) {
      if (refFlag !== undefined || force || dryRun) {
        throw usageError(
          "--check reads the working tree and sends nothing, so it cannot be combined with --ref, --force or --dry-run.",
        );
      }
      return checkWorkingTree(context);
    }
    const sessionId = optionalSessionOf(context);
    const location = (await locateAdrs(context, { binding: true })) as AdrLocation;
    const projectId = location.projectId as string;
    const root = location.root;
    if (root === null) {
      throw usageError(
        "adr sync reads a git commit, but this directory is not in a git repository.",
        "Run it in the repository, or use --check to validate the files.",
      );
    }
    if (!isAdrDirectory(location.directory)) {
      throw usageError(
        `The ADR directory ${location.directory} is not a path hive-mind accepts (at most 256 bytes, no control characters or backslashes).`,
      );
    }
    const ref = refFlag ?? DEFAULT_ADR_REF;
    const commitSha = await gitResolveCommit(root, context.env, ref);
    if (commitSha === null) {
      throw refFlag === undefined
        ? usageError(
            `This clone has no ${DEFAULT_ADR_REF}, so adr sync cannot tell which branch is the default.`,
            "Run 'git remote set-head origin --auto', or pass --ref.",
          )
        : usageError(`--ref ${ref} does not name a commit in this repository.`);
    }
    const display = await pathDisplay(context.cwd);
    const files = await readCommitAdrs(context, location, root, commitSha);
    const check = await checkAdrSet(files);
    if (check.duplicates.length > 0) throw duplicateNumbersError(check.duplicates);
    if (check.problems.length > 0) {
      throw adrInvalidError(
        context,
        `ADR sync refused: commit ${short(commitSha)} has invalid ADR files`,
        check.problems,
        display,
        "Fix them on the default branch, then sync again.",
      );
    }

    const api = await context.api();
    const { base, items } = await readCopy(api, projectId);
    const result = (outcome: SyncOutcome, rest: Partial<SyncData> = {}): SyncData => ({
      outcome,
      ref,
      commitSha,
      baseCommitSha: base,
      forced: force,
      fileCount: files.length,
      ...noChanges(),
      ...rest,
    });
    const position = await compareWithCopy(context, root, base, commitSha, force);
    if (position === "up_to_date") {
      return {
        data: result("up_to_date"),
        human: [`Already synced at commit ${short(commitSha)}.`],
      };
    }
    if (position === "already_synced_past") {
      return {
        data: result("already_synced_past"),
        human: [
          `Already synced past this commit: the copy is at ${short(base ?? "")}, which contains ${short(commitSha)}.`,
        ],
      };
    }

    if (dryRun) {
      const data = result("dry_run", {
        ...plannedChanges(check.adrs, items),
        warnings: boundedWarnings(check.warnings),
      });
      return {
        data,
        human: [
          `Dry run: would sync commit ${commitText(data)}: ${countsText(data)}`,
          ...data.changes.map(changeLine),
          ...warningLines(data, location.top, display),
          "Nothing was sent.",
        ],
      };
    }

    // Phase 1: content the copy does not have, each hash once.
    const known = new Set(items.map((item) => item.contentSha256));
    const missing = new Map<string, ParsedAdrSource>();
    for (const item of check.adrs) {
      if (!known.has(item.sha256) && !missing.has(item.sha256)) missing.set(item.sha256, item);
    }
    const uploads = [...missing.values()].map((item) => ({
      sha256: item.sha256,
      content: exactUtf8.decode(item.bytes),
      source: item.source,
    }));
    const refused: AdrFileProblem[] = [];
    for (const batch of planAdrUploads(uploads)) {
      const answer = await api.uploadAdrContents(
        projectId,
        batch.map(({ sha256, content }) => ({ sha256, content })),
      );
      for (const file of answer.files) {
        if (file.valid) continue;
        const source = batch.find((upload) => upload.sha256 === file.sha256)?.source;
        if (source === undefined) continue;
        for (const error of file.errors) refused.push({ source, ...error });
      }
    }
    if (refused.length > 0) {
      throw adrInvalidError(context, "The server refused ADR files", refused, display);
    }

    // Phase 2: replace the copy, compare-and-set on the base this run read.
    let synced: Awaited<ReturnType<HivemindApi["syncAdrs"]>>;
    try {
      synced = await api.syncAdrs(projectId, {
        commitSha,
        baseCommitSha: base,
        forced: force,
        directory: location.directory,
        entries: check.adrs.map((item) => ({
          fileName: item.source.fileName,
          sha256: item.sha256,
        })),
        sessionId,
      });
    } catch (error) {
      if (!isCliError(error)) throw error;
      if (error.code === "CONFLICT") {
        throw new CliError(error.code, error.message, {
          hint: "Another ADR sync finished first; run 'hivemind adr sync' again.",
          cause: error,
        });
      }
      if (isUncertainOutcome(error)) {
        throw new CliError(error.code, error.message, {
          hint: "The ADR sync may have been applied anyway. Running 'hivemind adr sync' again is safe.",
          cause: error,
        });
      }
      throw error;
    }
    const data = result(synced.changed ? "synced" : "up_to_date", {
      uploadedFileCount: uploads.length,
      added: synced.added,
      updated: synced.updated,
      removed: synced.removed,
      unchanged: synced.unchanged,
      changes: synced.changes,
      warnings: synced.warnings,
    });
    if (!synced.changed) {
      return { data, human: [`Already synced at commit ${short(commitSha)}.`] };
    }
    return {
      data,
      human: [
        `Synced commit ${commitText(data)}: ${countsText(data)}`,
        ...data.changes.map(changeLine),
        ...warningLines(data, location.top, display),
      ],
    };
  },
};
