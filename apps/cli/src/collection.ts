import {
  MAX_COLLECTION_BATCH_PATHS,
  MAX_MANAGEMENT_BODY_BYTES,
  touchedPathsContentHash,
} from "@hivemind/contract";
import type { ApiCollectionState, HivemindApi } from "./client.ts";
import { isCliError } from "./errors.ts";
import type { TouchedPathSelection } from "./git.ts";

/**
 * Uploading a touched-path collection (ADR-0014, issue #12 "Scopes and
 * overlap"): register the manifest, upload the batches in order, finalize.
 * The heartbeat that opened the collection has already renewed the leases;
 * none of this runs inside a server transaction, and nothing is retried.
 * Every input is derived deterministically from the selection, so rerunning
 * it for the same collection (`session heartbeat --collection-id`) replays
 * accepted steps as no-ops.
 */

const utf8 = new TextEncoder();

/** Bytes of the JSON body the client sends for one batch (path parameters are in the URL). */
export function batchBodyBytes(batchIndex: number, paths: readonly string[]): number {
  return utf8.encode(JSON.stringify({ batchIndex, paths })).byteLength;
}

/**
 * Splits sorted paths into consecutive batches of at most 16 paths whose
 * serialized request body also fits the server's 16 KiB limit. JSON escaping
 * can make 16 valid paths too large (a control character is six bytes), so a
 * batch closes early when the next path would not fit.
 */
export function planBatches(
  paths: readonly string[],
  maxBytes: number = MAX_MANAGEMENT_BODY_BYTES,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const path of paths) {
    const candidate = [...current, path];
    if (
      current.length > 0 &&
      (candidate.length > MAX_COLLECTION_BATCH_PATHS ||
        batchBodyBytes(batches.length, candidate) > maxBytes)
    ) {
      batches.push(current);
      current = [path];
    } else current = candidate;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface CollectionManifest {
  pathCount: number;
  batchCount: number;
  omittedPathCount: number;
  contentHash: string;
  batches: string[][];
}

export async function buildManifest(selection: TouchedPathSelection): Promise<CollectionManifest> {
  const batches = planBatches(selection.paths);
  return {
    pathCount: selection.paths.length,
    batchCount: batches.length,
    omittedPathCount: selection.omittedPathCount,
    contentHash: await touchedPathsContentHash(selection.paths),
    batches,
  };
}

export interface CollectionUploadResult {
  /** The last state a collection route returned; null when the manifest was not accepted. */
  collection: ApiCollectionState | null;
  /** Batches the server accepted in this run (new or replayed). */
  uploadedBatchCount: number;
  /** Paths the server could not store because the Session reached its touched-Scope limit. */
  overCapacityPathCount: number;
  /** The step that failed and its error; null when finalize succeeded. */
  error: { step: "manifest" | "batch" | "finalize"; code: string; message: string } | null;
}

/**
 * Registers, uploads and finalizes `manifest` for `collectionId`. A failing
 * step stops the upload and is returned, not thrown, so the caller can still
 * report the lease renewal that preceded it. Errors other than `CliError`
 * (bugs) propagate.
 */
export async function uploadCollection(
  api: HivemindApi,
  target: { projectId: string; sessionId: string; collectionId: string },
  manifest: CollectionManifest,
): Promise<CollectionUploadResult> {
  const result: CollectionUploadResult = {
    collection: null,
    uploadedBatchCount: 0,
    overCapacityPathCount: 0,
    error: null,
  };
  const { projectId, sessionId, collectionId } = target;
  let step: NonNullable<CollectionUploadResult["error"]>["step"] = "manifest";
  try {
    const registered = await api.registerCollectionManifest(projectId, {
      sessionId,
      collectionId,
      pathCount: manifest.pathCount,
      batchCount: manifest.batchCount,
      omittedPathCount: manifest.omittedPathCount,
      contentHash: manifest.contentHash,
    });
    result.collection = registered.collection;
    step = "batch";
    for (const [batchIndex, paths] of manifest.batches.entries()) {
      const uploaded = await api.uploadCollectionBatch(projectId, {
        sessionId,
        collectionId,
        batchIndex,
        paths,
      });
      result.collection = uploaded.collection;
      result.uploadedBatchCount++;
      result.overCapacityPathCount += uploaded.overCapacityPathCount;
    }
    step = "finalize";
    const finalized = await api.finalizeCollection(projectId, { sessionId, collectionId });
    result.collection = finalized.collection;
  } catch (error) {
    if (!isCliError(error)) throw error;
    result.error = { step, code: error.code, message: error.message };
  }
  return result;
}
