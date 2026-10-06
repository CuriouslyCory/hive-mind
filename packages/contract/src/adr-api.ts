import { z } from "zod";
import {
  ADR_SLUG_PATTERN,
  ADR_STATUSES,
  MAX_ADR_FILE_BYTES,
  MAX_ADR_NUMBER,
  MAX_ADR_SLUG_LENGTH,
  MAX_ADR_TITLE_LENGTH,
  MIN_ADR_NUMBER,
  parseAdrFileName,
  renderAdrTemplate,
} from "./adr.ts";
import { actorSchema } from "./auth.ts";
import {
  boundedListSchema,
  countSchema,
  cursorSchema,
  idSchema,
  MAX_PAGE_LIMIT,
  paginationInputShape,
  textSchema,
  timestampSchema,
  utf8ByteLength,
} from "./common.ts";
import { ADR_SYNC_CHANGE_KINDS } from "./event.ts";
import { actorSessionInputShape } from "./plan.ts";
import { contentHashSchema } from "./scope.ts";
import { gitBranchSchema, gitCommitSchema } from "./session.ts";

// The `/api/v1` ADR routes (issue #19, ADR-0017). The repository's
// `docs/adr/` files are the source of truth; hive-mind owns only ADR
// reservations (the numbers) and keeps a read-only copy of the files as of
// the last ADR sync. The file format and its parser are in adr.ts.

/**
 * Where a number is in hive-mind's copy, separate from the file's status and
 * never shown as one. `reserved`: handed out by `adr new`, no file synced
 * yet. `published`: the last ADR sync found a file with this number.
 * `removed`: an earlier sync found one and a later sync did not; the copy is
 * kept.
 */
export const ADR_STATES = ["reserved", "published", "removed"] as const;

/** Most ADRs one ADR may supersede. The upload route enforces it; the parser sets no bound. */
export const MAX_ADR_SUPERSEDES = 64;
/** Most errors, and most warnings, in one file's upload result. */
export const MAX_ADR_PROBLEMS = 16;
/** Most warnings on one ADR. */
export const MAX_ADR_WARNINGS = 32;
/** Longest problem message; the server shortens longer ones. */
export const MAX_ADR_PROBLEM_MESSAGE_LENGTH = 500;
/**
 * Longest uploaded file, in UTF-16 code units: a cheap bound the schema can
 * check. The parser checks the real limit, `MAX_ADR_FILE_BYTES` of UTF-8.
 */
export const MAX_ADR_CONTENT_LENGTH = MAX_ADR_FILE_BYTES;
/** Most files in one `POST .../adrs/contents`. */
export const MAX_ADR_CONTENT_BATCH_FILES = 50;
/** Most files one ADR sync may list: what fits in `MAX_ADR_UPLOAD_BODY_BYTES`. */
export const MAX_ADR_SYNC_ENTRIES = 1000;
/** Changes one sync can report: every listed file, plus every file it removed. */
export const MAX_ADR_SYNC_CHANGES = 2 * MAX_ADR_SYNC_ENTRIES;
/** Most warnings one sync result lists. */
export const MAX_ADR_SYNC_WARNINGS = 500;
/**
 * How far past the next ADR number a reservation's `floor` may move the
 * counter. A larger floor is CONFLICT: ADR sync, not the floor, brings in an
 * existing set.
 */
export const MAX_ADR_FLOOR_ADVANCE = 100;
/** Longest ADR directory path, in bytes of UTF-8. */
export const MAX_ADR_DIRECTORY_BYTES = 256;
/** Longest ADR file name: `NNNN-`, the longest slug, `.md`. */
export const MAX_ADR_FILE_NAME_LENGTH = 4 + 1 + MAX_ADR_SLUG_LENGTH + 3;
/**
 * Longest ADR path a response holds: a directory and a file name as a sync
 * request carries them. The directory is bounded in bytes, so this many code
 * units is also the most a path can take in UTF-8.
 */
export const MAX_ADR_PATH_LENGTH = MAX_ADR_DIRECTORY_BYTES + 1 + MAX_ADR_FILE_NAME_LENGTH;
/**
 * Largest JSON body of the two ADR upload routes (`.../adrs/contents` and
 * `.../adrs/sync`). Every other route keeps `MAX_MANAGEMENT_BODY_BYTES`.
 */
export const MAX_ADR_UPLOAD_BODY_BYTES = 256 * 1024;

export const adrStateSchema = z.enum(ADR_STATES);

export type AdrState = z.infer<typeof adrStateSchema>;

export const adrStatusSchema = z.enum(ADR_STATUSES);

export const adrNumberSchema = z.int().min(MIN_ADR_NUMBER).max(MAX_ADR_NUMBER);

/**
 * `{number}` in a path: a plain decimal from 1 to 9999 without leading zeros,
 * as `PLAN-12` has none. A typed client may pass a number.
 */
export const adrNumberParamSchema = z.union([
  adrNumberSchema,
  z
    .string()
    .regex(/^[1-9][0-9]{0,3}$/, "Must be an ADR number from 1 to 9999, without leading zeros.")
    .transform(Number)
    .pipe(adrNumberSchema),
]);

/** An ADR's title as stored: the synced file's H1, or a reservation's title. */
export const adrTitleSchema = textSchema(MAX_ADR_TITLE_LENGTH);

/**
 * The title of a new reservation: one `adr new` can write as the template's
 * H1 and read back unchanged (no leading or trailing spaces, no closing `#`s).
 */
export const newAdrTitleSchema = adrTitleSchema.refine(
  (title) => renderAdrTemplate({ title, date: "2000-01-01" }).ok,
  "Must read back unchanged as a markdown H1: no leading or trailing spaces or closing #.",
);

export const adrSlugSchema = z
  .string()
  .min(1)
  .max(MAX_ADR_SLUG_LENGTH)
  .regex(ADR_SLUG_PATTERN, "Use lowercase letters and digits joined by single hyphens.");

/** `YYYY-MM-DD`: the day the ADR's current status was set. */
export const adrDateSchema = z.iso.date();

/** An ADR file name such as `0015-adr-sync.md` (ADR-0001). */
export const adrFileNameSchema = z
  .string()
  .min(1)
  .max(MAX_ADR_FILE_NAME_LENGTH)
  .refine(
    (name) => parseAdrFileName(name).ok,
    "Must be an ADR file name: NNNN-slug.md with a number from 0001 to 9999.",
  );

// Control characters and backslashes, which a repository path in a request
// never needs.
const UNSAFE_PATH_CHARACTERS = /[\p{Cc}\\]/u;

/**
 * Whether `value` is an ADR directory: the repository-relative POSIX path
 * `docs/adr`, or `<dir>/docs/adr` when `.hivemind.json` is below the
 * repository root. No leading `/`, no empty, `.` or `..` segments, no
 * control characters or backslashes, at most 256 bytes.
 */
export function isAdrDirectory(value: string): boolean {
  if (!value.isWellFormed() || utf8ByteLength(value) > MAX_ADR_DIRECTORY_BYTES) return false;
  if (UNSAFE_PATH_CHARACTERS.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return value === "docs/adr" || value.endsWith("/docs/adr");
}

export const adrDirectorySchema = z
  .string()
  .min(1)
  .max(MAX_ADR_DIRECTORY_BYTES)
  .refine(isAdrDirectory, "Must be a repository-relative path ending in docs/adr.");

/** A synced ADR file's repository-relative path, `<directory>/<file name>`. */
export const adrPathSchema = z
  .string()
  .min(1)
  .max(MAX_ADR_PATH_LENGTH)
  .regex(
    /(?:^|\/)docs\/adr\/[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
    "Must be a path ending in docs/adr/NNNN-slug.md.",
  );

/**
 * A parser error or warning, or a sync notice. `code` is normally one of
 * `ADR_ERROR_CODES` or `ADR_WARNING_CODES`; the server also uses
 * `ADR_SHA256_MISMATCH` for an upload whose hash does not match. Clients must
 * accept codes they do not know.
 */
export const adrProblemSchema = z.strictObject({
  code: z
    .string()
    .max(64)
    .regex(/^ADR_[A-Z0-9_]+$/),
  message: z.string().min(1).max(MAX_ADR_PROBLEM_MESSAGE_LENGTH),
});

export type AdrProblem = z.infer<typeof adrProblemSchema>;

/** A number reserved with `adr new`. It never changes, even when a file with another title takes the number. */
export const adrReservationSchema = z.strictObject({
  title: adrTitleSchema,
  slug: adrSlugSchema,
  /** The reserving client's git branch; null when it could not tell. */
  gitBranch: gitBranchSchema.nullable(),
  reservedBy: actorSchema,
  /** The Session the reservation was attributed to, if any. */
  sessionId: idSchema.nullable(),
  reservedAt: timestampSchema,
});

export type AdrReservation = z.infer<typeof adrReservationSchema>;

const adrSummaryShape = {
  id: idSchema,
  projectId: idSchema,
  number: adrNumberSchema,
  /** Where the number is in hive-mind's copy. Never a status. */
  state: adrStateSchema,
  /** The synced file's H1; the reserved title while `reserved`. */
  title: adrTitleSchema,
  /** The synced file's slug; the reserved slug while `reserved`. */
  slug: adrSlugSchema,
  // Null only while `reserved`. A `removed` ADR keeps its last copy's values.
  path: adrPathSchema.nullable(),
  status: adrStatusSchema.nullable(),
  date: adrDateSchema.nullable(),
  /** Numbers this ADR supersedes, in file order; empty while `reserved`. */
  supersedes: z.array(adrNumberSchema).max(MAX_ADR_SUPERSEDES),
  contentSha256: contentHashSchema.nullable(),
  /** The synced commit at which this ADR's content last changed. */
  commitSha: gitCommitSchema.nullable(),
  /** When an ADR sync last changed this ADR. */
  syncedAt: timestampSchema.nullable(),
  /** Null for a number nobody reserved: its file bypassed `adr new`. */
  reservation: adrReservationSchema.nullable(),
  /**
   * A synced file took this reserved number: its slug and title both differ
   * from the reservation's. The file keeps the number, and the reserved ADR
   * needs a new one. Always false while `reserved`.
   */
  reservationTaken: z.boolean(),
  /** How many warnings the ADR's detail lists. */
  warningCount: countSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

/** An ADR without its content, as the ADR list shows it. */
export const adrSummarySchema = z.strictObject(adrSummaryShape);

export type AdrSummary = z.infer<typeof adrSummarySchema>;

/** An ADR with its content. */
export const adrSchema = z.strictObject({
  ...adrSummaryShape,
  /** The whole file as synced, frontmatter included; null while `reserved`. */
  content: z.string().min(1).max(MAX_ADR_CONTENT_LENGTH).nullable(),
  /** Published ADRs whose `supersedes` lists this number, ascending. */
  supersededBy: z.array(adrNumberSchema).max(MAX_ADR_NUMBER),
  /** The parser's warnings about this content; empty while `reserved`. */
  warnings: z.array(adrProblemSchema).max(MAX_ADR_WARNINGS),
});

export type Adr = z.infer<typeof adrSchema>;

/** The Project's last ADR sync: the commit it read, when, and who ran it. */
export const adrSyncStateSchema = z.strictObject({
  commitSha: gitCommitSchema,
  syncedAt: timestampSchema,
  syncedBy: actorSchema,
});

export type AdrSyncState = z.infer<typeof adrSyncStateSchema>;

/**
 * `GET /projects/{id}/adrs`: ADRs and reservations, highest number first. A
 * `status` filter leaves out reservations, which have none.
 */
export const listAdrsInputSchema = z.strictObject({
  id: idSchema,
  status: adrStatusSchema.optional(),
  state: adrStateSchema.optional(),
  ...paginationInputShape,
});

export type ListAdrsInput = z.input<typeof listAdrsInputSchema>;

export const adrPageSchema = z.strictObject({
  items: z.array(adrSummarySchema).max(MAX_PAGE_LIMIT),
  nextCursor: cursorSchema.nullable(),
  /** The last ADR sync, on every page; null until the first one. */
  lastSync: adrSyncStateSchema.nullable(),
});

export type AdrPage = z.infer<typeof adrPageSchema>;

/**
 * `POST /projects/{id}/adrs`: reserve the Project's next ADR number.
 * `adrId` is generated once by the client; replay follows
 * `createPlanInputSchema` and returns the ADR as it is now, even once
 * synced. `floor` is the highest ADR number the client saw in its working
 * tree and on the default branch (0 for none); a floor more than
 * `MAX_ADR_FLOOR_ADVANCE` past the next number, or no number left below
 * 10000, is CONFLICT.
 */
export const reserveAdrInputSchema = z.strictObject({
  id: idSchema,
  adrId: idSchema,
  title: newAdrTitleSchema,
  slug: adrSlugSchema,
  floor: z.int().min(0).max(MAX_ADR_NUMBER).optional(),
  gitBranch: gitBranchSchema.optional(),
  ...actorSessionInputShape,
});

export type ReserveAdrInput = z.input<typeof reserveAdrInputSchema>;

export const reserveAdrOutputSchema = z.strictObject({
  adr: adrSchema,
  created: z.boolean(),
});

export type ReserveAdrOutput = z.infer<typeof reserveAdrOutputSchema>;

/** `GET /projects/{id}/adrs/{number}`: an ADR or reservation of any state. */
export const getAdrInputSchema = z.strictObject({
  id: idSchema,
  number: adrNumberParamSchema,
});

export type GetAdrInput = z.input<typeof getAdrInputSchema>;

export const getAdrOutputSchema = z.strictObject({
  adr: adrSchema,
  lastSync: adrSyncStateSchema.nullable(),
});

export type GetAdrOutput = z.infer<typeof getAdrOutputSchema>;

function distinct<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

/** One file to upload: its whole contents and the client's sha256 of their UTF-8 bytes. */
export const adrContentFileSchema = z.strictObject({
  sha256: contentHashSchema,
  content: z.string().max(MAX_ADR_CONTENT_LENGTH),
});

/**
 * `POST /projects/{id}/adrs/contents`: files for a later ADR sync, addressed
 * by sha256. The server parses each file itself and stores the valid ones;
 * a problem with one file is reported in its result, never as an error of
 * the request. Storing content changes nothing in the copy until a sync
 * names it, and writes no Event.
 */
export const uploadAdrContentsInputSchema = z.strictObject({
  id: idSchema,
  files: z
    .array(adrContentFileSchema)
    .min(1)
    .max(MAX_ADR_CONTENT_BATCH_FILES)
    .refine((files) => distinct(files, (file) => file.sha256), "Each sha256 may appear once."),
});

export type UploadAdrContentsInput = z.input<typeof uploadAdrContentsInputSchema>;

export const adrContentResultSchema = z.strictObject({
  sha256: contentHashSchema,
  /** The file parsed without errors and is stored (by this request or earlier). */
  valid: z.boolean(),
  /** Stored by this request: false for content the Project already had, and for invalid content. */
  created: z.boolean(),
  /** Why the file cannot be stored; empty when `valid`. */
  errors: z.array(adrProblemSchema).max(MAX_ADR_PROBLEMS),
  warnings: z.array(adrProblemSchema).max(MAX_ADR_PROBLEMS),
});

export type AdrContentResult = z.infer<typeof adrContentResultSchema>;

export const uploadAdrContentsOutputSchema = z.strictObject({
  /** One result per uploaded file, in request order. */
  files: z.array(adrContentResultSchema).max(MAX_ADR_CONTENT_BATCH_FILES),
});

export type UploadAdrContentsOutput = z.infer<typeof uploadAdrContentsOutputSchema>;

/** One ADR file of the synced commit, named within `directory`. */
export const adrSyncEntrySchema = z.strictObject({
  fileName: adrFileNameSchema,
  /** Uploaded already, and valid. */
  sha256: contentHashSchema,
});

/**
 * `POST /projects/{id}/adrs/sync`: make the copy match the ADR files of one
 * commit, all or nothing. `baseCommitSha` must be the last synced commit
 * (`lastSync.commitSha`, null before the first sync); otherwise CONFLICT.
 * Two files with one number are CONFLICT; content not uploaded or not valid
 * is BAD_REQUEST. Files missing from the commit become `removed`, never
 * deleted. `forced` says the client skipped its git ancestry check; it is
 * recorded, and the compare-and-set still applies. Repeating a sync of the
 * last synced commit with the same files changes nothing.
 */
export const syncAdrsInputSchema = z.strictObject({
  id: idSchema,
  commitSha: gitCommitSchema,
  baseCommitSha: gitCommitSchema.nullable(),
  forced: z.boolean().optional(),
  directory: adrDirectorySchema,
  entries: z
    .array(adrSyncEntrySchema)
    .max(MAX_ADR_SYNC_ENTRIES)
    .refine(
      (entries) => distinct(entries, (entry) => entry.fileName),
      "Each file name may appear once.",
    ),
  ...actorSessionInputShape,
});

export type SyncAdrsInput = z.input<typeof syncAdrsInputSchema>;

/**
 * How one ADR changed in a sync (`ADR_SYNC_CHANGE_KINDS`). A status is null
 * where there is no published copy: before `added` or `restored`, after
 * `removed`.
 */
export const adrChangeSchema = z.strictObject({
  number: adrNumberSchema,
  change: z.enum(ADR_SYNC_CHANGE_KINDS),
  /** The path after the sync; the last path for `removed`. */
  path: adrPathSchema,
  statusFrom: adrStatusSchema.nullable(),
  statusTo: adrStatusSchema.nullable(),
});

export type AdrChange = z.infer<typeof adrChangeSchema>;

/** Something about one synced file that someone should look at. */
export const adrSyncWarningSchema = z.strictObject({
  number: adrNumberSchema,
  path: adrPathSchema,
  ...adrProblemSchema.shape,
});

export type AdrSyncWarning = z.infer<typeof adrSyncWarningSchema>;

export const syncAdrsOutputSchema = z.strictObject({
  /** False when this commit was already synced with the same files: nothing was written. */
  changed: z.boolean(),
  /** The last sync, after this request. */
  lastSync: adrSyncStateSchema,
  /** The commit synced before this request; null for the first sync. */
  previousCommitSha: gitCommitSchema.nullable(),
  forced: z.boolean(),
  /** Includes `restored`, as the `adr.synced` Event counts it. */
  added: countSchema,
  updated: countSchema,
  removed: countSchema,
  unchanged: countSchema,
  /** Every change, by number. The `adr.synced` Event lists only the first 100. */
  changes: z.array(adrChangeSchema).max(MAX_ADR_SYNC_CHANGES),
  /** When `complete` is false, `GET .../adrs/{number}` shows each ADR's warnings. */
  warnings: boundedListSchema(adrSyncWarningSchema, MAX_ADR_SYNC_WARNINGS),
});

export type SyncAdrsOutput = z.infer<typeof syncAdrsOutputSchema>;
