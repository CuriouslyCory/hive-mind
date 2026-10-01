import { createHash } from "node:crypto";
import {
  compareTouchedPaths,
  MAX_COLLECTION_BATCH_PATHS,
  MAX_MANAGEMENT_BODY_BYTES,
  registerCollectionManifestInputSchema,
  uploadCollectionBatchInputSchema,
} from "@hivemind/contract";
import { describe, expect, it } from "vitest";
import { batchBodyBytes, buildManifest, planBatches } from "../src/collection.ts";

const ID = "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";

describe("planBatches", () => {
  it("splits sorted paths into consecutive batches of at most 16", () => {
    const paths = Array.from({ length: 40 }, (_, i) => `src/file-${String(i).padStart(2, "0")}.ts`);
    const batches = planBatches(paths);
    expect(batches.map((batch) => batch.length)).toEqual([16, 16, 8]);
    expect(batches.flat()).toEqual(paths);
  });

  it("closes a batch early when its JSON body would exceed 16 KiB", () => {
    // 256-byte paths of control characters: each escapes to 6 bytes per
    // character in JSON, so 16 of them would be about 24 KiB.
    const paths = Array.from(
      { length: 16 },
      (_, i) => `${String.fromCharCode(0x41 + i)}${"\u0001".repeat(255)}`,
    ).sort(compareTouchedPaths);
    const batches = planBatches(paths);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(paths);
    for (const [index, batch] of batches.entries()) {
      expect(batch.length).toBeLessThanOrEqual(MAX_COLLECTION_BATCH_PATHS);
      expect(batchBodyBytes(index, batch)).toBeLessThanOrEqual(MAX_MANAGEMENT_BODY_BYTES);
      // Every batch is what the contract accepts.
      const input = { id: ID, sessionId: ID, collectionId: ID, batchIndex: index, paths: batch };
      expect(uploadCollectionBatchInputSchema.safeParse(input).success).toBe(true);
    }
  });

  it("is deterministic and empty for no paths", () => {
    const paths = Array.from({ length: 33 }, (_, i) => `p${i}`).sort(compareTouchedPaths);
    expect(planBatches(paths)).toEqual(planBatches([...paths]));
    expect(planBatches([])).toEqual([]);
  });
});

describe("buildManifest", () => {
  it("hashes the contract's canonical text and fits the manifest schema", async () => {
    const paths = ["a.ts", "b/c.ts", "é.md"].sort(compareTouchedPaths);
    const manifest = await buildManifest({ paths, omittedPathCount: 2 });
    const canonical = paths.map((path) => `${path}\0`).join("");
    expect(manifest.contentHash).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
    expect(manifest).toMatchObject({ pathCount: 3, batchCount: 1, omittedPathCount: 2 });
    const input = {
      id: ID,
      sessionId: ID,
      collectionId: ID,
      pathCount: manifest.pathCount,
      batchCount: manifest.batchCount,
      omittedPathCount: manifest.omittedPathCount,
      contentHash: manifest.contentHash,
    };
    expect(registerCollectionManifestInputSchema.safeParse(input).success).toBe(true);
  });

  it("describes an empty collection as zero paths in zero batches", async () => {
    const manifest = await buildManifest({ paths: [], omittedPathCount: 0 });
    expect(manifest).toMatchObject({ pathCount: 0, batchCount: 0, batches: [] });
    expect(manifest.contentHash).toBe(createHash("sha256").update("").digest("hex"));
  });
});
