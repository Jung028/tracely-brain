// Coverage for src/brain/index.ts — the public barrel export and the NFR-10
// onRead/onWrite hook scaffold. Not a re-test of entities.ts/relationships.ts/
// query.ts business logic (already covered elsewhere) — just: do the barrel's
// wrapper functions delegate correctly, do hooks fire with the right
// `operation`, does configureBrainHooks replace rather than merge, and does a
// hook correctly NOT fire when the wrapped call throws.

import { afterEach, describe, expect, test } from "bun:test";
import {
  configureBrainHooks,
  EntityNotFoundError,
  getEntity,
  upsertEntity,
  type BrainHookEvent,
} from "../src/brain/index";
import { truncateAll } from "./db-helpers";

afterEach(async () => {
  await truncateAll();
  configureBrainHooks({}); // reset to no-ops so hooks don't leak across tests
});

describe("configureBrainHooks", () => {
  test("onRead/onWrite fire with the correct operation when calling through the barrel", async () => {
    const reads: BrainHookEvent[] = [];
    const writes: BrainHookEvent[] = [];
    configureBrainHooks({
      onRead: (e) => reads.push(e),
      onWrite: (e) => writes.push(e),
    });

    const entity = await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "barrel-repo",
      sourceSystem: "manual",
      sourceRef: "test:barrel:upsert",
    });
    expect(writes.map((e) => e.operation)).toEqual(["upsertEntity"]);
    expect(reads.length).toBe(0);

    await getEntity(entity.id);
    expect(reads.map((e) => e.operation)).toEqual(["getEntity"]);
  });

  test("does NOT fire onRead when the wrapped call throws", async () => {
    const reads: BrainHookEvent[] = [];
    configureBrainHooks({ onRead: (e) => reads.push(e) });

    await expect(
      getEntity("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(EntityNotFoundError);

    expect(reads.length).toBe(0);
  });

  test("replaces (does not merge) previously registered hooks", async () => {
    const firstReads: BrainHookEvent[] = [];
    const secondWrites: BrainHookEvent[] = [];

    configureBrainHooks({ onRead: (e) => firstReads.push(e) });
    // Registering again with only onWrite must drop the previous onRead —
    // configureBrainHooks replaces the whole hook set, it never merges.
    configureBrainHooks({ onWrite: (e) => secondWrites.push(e) });

    const entity = await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "barrel-replace",
      sourceSystem: "manual",
      sourceRef: "test:barrel:replace",
    });
    await getEntity(entity.id);

    expect(secondWrites.map((e) => e.operation)).toEqual(["upsertEntity"]);
    // The first registration's onRead must not fire — it was replaced, not
    // merged in alongside the second registration's onWrite.
    expect(firstReads.length).toBe(0);
  });
});
