import { afterEach, describe, expect, test } from "bun:test";
import { upsertEntity } from "../src/brain/entities";
import { recordRelationshipObservation } from "../src/brain/relationships";
import {
  getProvenance,
  getRelationshipHistory,
  isValidRelationshipType,
  queryRelationships,
  traverse,
} from "../src/brain/query";
import { truncateAll } from "./db-helpers";
import { seedExampleChain } from "./fixtures/example-chain";

afterEach(async () => {
  await truncateAll();
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Small multi-domain fixture spanning three domains (Code, Runtime, Data)
 * and two relationship types (DEPENDS_ON, WRITES), with the A->B edge
 * versioned once so a historical row exists alongside the current one.
 *
 * Timeline:
 *   t0: A --DEPENDS_ON{criticality:low}--> B   (created)
 *   t1: (validAt probe point between the two DEPENDS_ON versions)
 *   t2: A --DEPENDS_ON{criticality:high}--> B  (versioned: v1 -> historical)
 *   t3: B --WRITES-->                       C  (created, corroborated by a
 *                                               second source for the
 *                                               getProvenance test)
 */
async function seedMultiDomainFixture() {
  const a = await upsertEntity({
    domain: "Code",
    entityType: "Repository",
    name: "entity-a",
    sourceSystem: "manual",
    sourceRef: "test:query:a",
  });
  const b = await upsertEntity({
    domain: "Runtime",
    entityType: "Service",
    name: "entity-b",
    sourceSystem: "manual",
    sourceRef: "test:query:b",
  });
  const c = await upsertEntity({
    domain: "Data",
    entityType: "Table",
    name: "entity-c",
    sourceSystem: "manual",
    sourceRef: "test:query:c",
  });

  const v1 = await recordRelationshipObservation({
    fromEntityId: a.id,
    toEntityId: b.id,
    relationshipType: "DEPENDS_ON",
    attributes: { criticality: "low" },
    sourceSystem: "manual",
    sourceRef: "test:query:ab:v1",
  });

  await sleep(15);
  const validAtBetweenVersions = new Date();
  await sleep(15);

  const v2 = await recordRelationshipObservation({
    fromEntityId: a.id,
    toEntityId: b.id,
    relationshipType: "DEPENDS_ON",
    attributes: { criticality: "high" },
    sourceSystem: "manual",
    sourceRef: "test:query:ab:v2",
  });

  const bc = await recordRelationshipObservation({
    fromEntityId: b.id,
    toEntityId: c.id,
    relationshipType: "WRITES",
    attributes: { table: "c" },
    sourceSystem: "manual",
    sourceRef: "test:query:bc:source1",
  });
  // Second source corroborating the same B->C edge, for getProvenance.
  await recordRelationshipObservation({
    fromEntityId: b.id,
    toEntityId: c.id,
    relationshipType: "WRITES",
    attributes: { table: "c" },
    sourceSystem: "datadog",
    sourceRef: "test:query:bc:source2",
  });

  return {
    a,
    b,
    c,
    abV1: v1.relationship,
    abV2: v2.relationship,
    bc: bc.relationship,
    validAtBetweenVersions,
  };
}

describe("queryRelationships", () => {
  test("filters by domain (matches either endpoint entity's domain)", async () => {
    const { abV2, bc } = await seedMultiDomainFixture();

    const codeResults = await queryRelationships({ domain: "Code" });
    expect(codeResults.map((r) => r.id)).toEqual([abV2.id]);

    const dataResults = await queryRelationships({ domain: "Data" });
    expect(dataResults.map((r) => r.id)).toEqual([bc.id]);

    // Runtime (entity B) is an endpoint of both edges.
    const runtimeResults = await queryRelationships({ domain: "Runtime" });
    const runtimeIds = runtimeResults.map((r) => r.id).sort();
    expect(runtimeIds).toEqual([abV2.id, bc.id].sort());
  });

  test("filters by relationshipType (single value and array)", async () => {
    const { abV2, bc } = await seedMultiDomainFixture();

    const single = await queryRelationships({ relationshipType: "WRITES" });
    expect(single.map((r) => r.id)).toEqual([bc.id]);

    const both = await queryRelationships({
      relationshipType: ["DEPENDS_ON", "WRITES"],
    });
    const bothIds = both.map((r) => r.id).sort();
    expect(bothIds).toEqual([abV2.id, bc.id].sort());
  });

  test("validAt overrides status filtering: returns the version valid at that instant", async () => {
    const { abV1, abV2, validAtBetweenVersions } =
      await seedMultiDomainFixture();

    const atMidpoint = await queryRelationships({
      fromEntityId: abV1.fromEntityId,
      toEntityId: abV1.toEntityId,
      relationshipType: "DEPENDS_ON",
      validAt: validAtBetweenVersions,
    });
    expect(atMidpoint.length).toBe(1);
    expect(atMidpoint[0]?.id).toBe(abV1.id);
    expect(atMidpoint[0]?.attributes).toEqual({ criticality: "low" });

    const now = await queryRelationships({
      fromEntityId: abV1.fromEntityId,
      toEntityId: abV1.toEntityId,
      relationshipType: "DEPENDS_ON",
      validAt: new Date(),
    });
    expect(now.length).toBe(1);
    expect(now[0]?.id).toBe(abV2.id);
    expect(now[0]?.attributes).toEqual({ criticality: "high" });
  });

  test("combines multiple filters with AND semantics", async () => {
    const { abV2 } = await seedMultiDomainFixture();

    // Runtime alone matches both edges (see domain test above); adding
    // relationshipType: DEPENDS_ON narrows it down to just A->B.
    const results = await queryRelationships({
      domain: "Runtime",
      relationshipType: "DEPENDS_ON",
    });
    expect(results.map((r) => r.id)).toEqual([abV2.id]);
  });

  test("limit bounds the result set and orders deterministically (tie-breaker on r.id)", async () => {
    await seedMultiDomainFixture();

    const limited = await queryRelationships({ status: "any", limit: 2 });
    expect(limited.length).toBe(2);

    // Re-running the identical query must return the identical ordering —
    // ORDER BY created_at alone has no tie-breaker, so rows sharing a
    // created_at (common under bulk ingestion in one transaction) would
    // otherwise return in a nondeterministic subset.
    const limitedAgain = await queryRelationships({ status: "any", limit: 2 });
    expect(limitedAgain.map((r) => r.id)).toEqual(limited.map((r) => r.id));

    const all = await queryRelationships({ status: "any" });
    expect(all.length).toBe(3);
    expect(limited.map((r) => r.id)).toEqual(all.slice(0, 2).map((r) => r.id));
  });

  test("status: 'historical' returns superseded rows", async () => {
    const { abV1 } = await seedMultiDomainFixture();

    const historical = await queryRelationships({ status: "historical" });
    expect(historical.map((r) => r.id)).toEqual([abV1.id]);
    expect(historical[0]?.status).toBe("historical");
  });

  test("status: 'any' returns both current and historical rows for a filtered edge", async () => {
    const { abV1, abV2 } = await seedMultiDomainFixture();

    const any = await queryRelationships({
      fromEntityId: abV1.fromEntityId,
      toEntityId: abV1.toEntityId,
      relationshipType: "DEPENDS_ON",
      status: "any",
    });
    const ids = any.map((r) => r.id).sort();
    expect(ids).toEqual([abV1.id, abV2.id].sort());
  });

  test("default status is 'current': excludes historical rows", async () => {
    const { abV1, abV2 } = await seedMultiDomainFixture();

    const results = await queryRelationships({
      fromEntityId: abV1.fromEntityId,
      toEntityId: abV1.toEntityId,
      relationshipType: "DEPENDS_ON",
    });
    expect(results.map((r) => r.id)).toEqual([abV2.id]);
  });
});

describe("getRelationshipHistory", () => {
  test("returns the full chain (current + historical) ordered by validFrom ascending", async () => {
    const { a, b, abV1, abV2 } = await seedMultiDomainFixture();

    const history = await getRelationshipHistory(a.id, b.id, "DEPENDS_ON");

    expect(history.length).toBe(2);
    expect(history[0]?.id).toBe(abV1.id);
    expect(history[0]?.status).toBe("historical");
    expect(history[1]?.id).toBe(abV2.id);
    expect(history[1]?.status).toBe("current");
    expect(history[0]!.validFrom.getTime()).toBeLessThanOrEqual(
      history[1]!.validFrom.getTime(),
    );
  });
});

describe("getProvenance", () => {
  test("returns all provenance rows for a multi-source-corroborated relationship", async () => {
    const { bc } = await seedMultiDomainFixture();

    const provenance = await getProvenance(bc.id);

    expect(provenance.length).toBe(2);
    const sources = provenance.map((p) => p.sourceSystem).sort();
    expect(sources).toEqual(["datadog", "manual"]);
    for (const row of provenance) {
      expect(row.relationshipId).toBe(bc.id);
    }
  });

  test("returns exactly the creating observation when nothing further corroborated it", async () => {
    const { abV2 } = await seedMultiDomainFixture();

    const provenance = await getProvenance(abV2.id);
    expect(provenance.length).toBe(1);
    expect(provenance[0]?.sourceRef).toBe("test:query:ab:v2");
  });
});

describe("traverse", () => {
  test("reaches all 12 hops / 13 entities of the example chain with a sufficient maxDepth", async () => {
    const chain = await seedExampleChain();

    const result = await traverse({
      startEntityId: chain.chargebackId,
      maxDepth: 15,
    });

    expect(result.relationships.length).toBe(12);
    expect(result.entities.length).toBe(13);

    const maxDepthReached = Math.max(
      ...result.relationships.map((r) => r.depth),
    );
    expect(maxDepthReached).toBe(12);

    const entityIds = new Set(result.entities.map((e) => e.id));
    expect(entityIds.has(chain.chargebackId)).toBe(true);
    expect(entityIds.has(chain.downstreamServiceId)).toBe(true);
    expect(entityIds.has(chain.databaseTableId)).toBe(true);

    // Depths increase monotonically along the chain — hop 1 is depth 1, ...,
    // hop 12 is depth 12.
    const depths = result.relationships.map((r) => r.depth).sort((x, y) => x - y);
    expect(depths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("a maxDepth smaller than the chain length truncates to the reachable prefix", async () => {
    const chain = await seedExampleChain();

    const result = await traverse({
      startEntityId: chain.chargebackId,
      maxDepth: 4,
    });

    expect(result.relationships.length).toBe(4);
    const depths = result.relationships.map((r) => r.depth).sort((x, y) => x - y);
    expect(depths).toEqual([1, 2, 3, 4]);

    // 4 hops from Chargeback reach: CB Center, ICB Center, WAIT_JUDGE,
    // Liability Assignment, plus the start entity itself = 5 entities.
    expect(result.entities.length).toBe(5);
    const entityIds = new Set(result.entities.map((e) => e.id));
    expect(entityIds.has(chain.liabilityAssignmentId)).toBe(true);
    expect(entityIds.has(chain.schedulerId)).toBe(false);
  });

  test("respects relationshipTypes filter", async () => {
    const chain = await seedExampleChain();

    const result = await traverse({
      startEntityId: chain.chargebackId,
      relationshipTypes: ["TRANSITIONS_TO"],
      maxDepth: 15,
    });

    // Only the first 3 hops (Chargeback->CB Center->ICB Center->WAIT_JUDGE)
    // are TRANSITIONS_TO; the chain then continues with other types, so the
    // walk stops there.
    expect(result.relationships.length).toBe(3);
    for (const r of result.relationships) {
      expect(r.relationshipType).toBe("TRANSITIONS_TO");
    }
  });

  test("incoming direction walks the chain backward from a downstream entity", async () => {
    const chain = await seedExampleChain();

    const result = await traverse({
      startEntityId: chain.downstreamServiceId,
      direction: "incoming",
      maxDepth: 15,
    });

    expect(result.relationships.length).toBe(12);
    expect(result.entities.length).toBe(13);
  });

  test("both direction reaches the whole chain from a midpoint entity, with no duplicate edges", async () => {
    const chain = await seedExampleChain();

    const result = await traverse({
      startEntityId: chain.liabilityAssignmentId,
      direction: "both",
      maxDepth: 15,
    });

    // From the midpoint, outgoing covers 8 hops forward (Liability
    // Assignment -> ... -> Downstream Service) and incoming covers 4 hops
    // backward (Liability Assignment <- ... <- Chargeback) = 12 distinct
    // edges / 13 distinct entities, with no edge double-counted.
    expect(result.relationships.length).toBe(12);
    expect(result.entities.length).toBe(13);
    const relationshipIds = new Set(result.relationships.map((r) => r.id));
    expect(relationshipIds.size).toBe(12);

    const entityIds = new Set(result.entities.map((e) => e.id));
    expect(entityIds.has(chain.chargebackId)).toBe(true);
    expect(entityIds.has(chain.downstreamServiceId)).toBe(true);
  });

  test("maxDepth of 0 or negative returns an empty result without querying", async () => {
    const chain = await seedExampleChain();

    const zero = await traverse({ startEntityId: chain.chargebackId, maxDepth: 0 });
    expect(zero).toEqual({ entities: [], relationships: [] });

    const negative = await traverse({
      startEntityId: chain.chargebackId,
      maxDepth: -3,
    });
    expect(negative).toEqual({ entities: [], relationships: [] });
  });

  describe("cycle guard", () => {
    /**
     * A 3-entity cycle: X --CALLS--> Y --CALLS--> Z --CALLS--> X.
     *
     * With no cycle guard, a recursive walk from X would loop forever (or
     * until some other limit kicked in): X->Y->Z->X->Y->Z->... With the
     * guard (`NOT (next_entity_id = ANY(w.visited))` in every recursive
     * term), the walk must stop the instant it would revisit an already-
     * visited node.
     *
     * Note the exact count this produces for a direction-consistent walk:
     * the seed row's `visited` array is `ARRAY[from_entity_id, to_entity_id]`
     * (or the swapped equivalent for `incoming`), which bakes the *start*
     * entity itself into `visited` from depth 1 — not just nodes visited
     * mid-walk. So a pure `outgoing` (or `incoming`) walk around an n-node
     * cycle can never traverse the edge that closes the loop back to the
     * start: it always stops at n-1 edges, never n. Verified empirically
     * against live Postgres before asserting below (a naive "expect 3"
     * assertion for `outgoing`/`incoming` fails — this is exercising the
     * guard as actually implemented, not a hoped-for count). `direction:
     * 'both'` recovers all 3 edges because its two independent walks each
     * miss a *different* closing edge, and their union covers everything.
     * In every case, a maxDepth of 10 (far larger than the 3-edge cycle)
     * still returns a small, bounded, exact count instead of growing
     * without limit — proving the guard actually terminates the walk
     * rather than the query merely happening not to hang.
     */
    async function seedCycle() {
      const x = await upsertEntity({
        domain: "Runtime",
        entityType: "Service",
        name: "cycle-x",
        sourceSystem: "manual",
        sourceRef: "test:query:cycle:x",
      });
      const y = await upsertEntity({
        domain: "Runtime",
        entityType: "Service",
        name: "cycle-y",
        sourceSystem: "manual",
        sourceRef: "test:query:cycle:y",
      });
      const z = await upsertEntity({
        domain: "Runtime",
        entityType: "Service",
        name: "cycle-z",
        sourceSystem: "manual",
        sourceRef: "test:query:cycle:z",
      });

      const xy = await recordRelationshipObservation({
        fromEntityId: x.id,
        toEntityId: y.id,
        relationshipType: "CALLS",
        attributes: {},
        sourceSystem: "manual",
        sourceRef: "test:query:cycle:xy",
      });
      const yz = await recordRelationshipObservation({
        fromEntityId: y.id,
        toEntityId: z.id,
        relationshipType: "CALLS",
        attributes: {},
        sourceSystem: "manual",
        sourceRef: "test:query:cycle:yz",
      });
      const zx = await recordRelationshipObservation({
        fromEntityId: z.id,
        toEntityId: x.id,
        relationshipType: "CALLS",
        attributes: {},
        sourceSystem: "manual",
        sourceRef: "test:query:cycle:zx",
      });

      return {
        x,
        y,
        z,
        xy: xy.relationship,
        yz: yz.relationship,
        zx: zx.relationship,
      };
    }

    test("outgoing: a maxDepth far larger than the cycle length still terminates at exactly n-1 edges (the guard blocks the closing edge back to start)", async () => {
      const cycle = await seedCycle();

      const result = await traverse({
        startEntityId: cycle.x.id,
        direction: "outgoing",
        maxDepth: 10,
      });

      // X->Y (xy), Y->Z (yz) are walked; Z->X (zx) is blocked because X
      // (the start) is already in `visited` from the seed row. Without the
      // guard this would either loop forever or (bounded only by maxDepth)
      // keep re-walking X->Y->Z->X->Y->Z->... and returning duplicate/
      // growing rows — not a small, stable count of exactly 2.
      const ids = result.relationships.map((r) => r.id).sort();
      expect(ids).toEqual([cycle.xy.id, cycle.yz.id].sort());
      expect(result.relationships.length).toBe(2);
      expect(result.entities.length).toBe(3);
    });

    test("incoming: a maxDepth far larger than the cycle length still terminates at exactly n-1 edges (the guard blocks the closing edge back to start)", async () => {
      const cycle = await seedCycle();

      const result = await traverse({
        startEntityId: cycle.x.id,
        direction: "incoming",
        maxDepth: 10,
      });

      // Walking backward from X: Z->X (zx), then Y->Z (yz) are walked;
      // X->Y (xy) is blocked because X (the start) is already in `visited`.
      const ids = result.relationships.map((r) => r.id).sort();
      expect(ids).toEqual([cycle.zx.id, cycle.yz.id].sort());
      expect(result.relationships.length).toBe(2);
      expect(result.entities.length).toBe(3);
    });

    test("both: a maxDepth far larger than the cycle length still terminates, unioning both n-1-edge walks into the full 3-edge cycle with no duplicates", async () => {
      const cycle = await seedCycle();

      const result = await traverse({
        startEntityId: cycle.x.id,
        direction: "both",
        maxDepth: 10,
      });

      // walk_out (outgoing) covers {xy, yz}, missing zx (the edge closing
      // back to X). walk_in (incoming) covers {zx, yz}, missing xy (the
      // edge closing back to X from the other side). Their union covers
      // all 3 edges exactly once each — both walks terminate correctly
      // (guarded, not merely "didn't happen to hang"), and neither one
      // alone captures the full cycle.
      const ids = result.relationships.map((r) => r.id).sort();
      expect(ids).toEqual([cycle.xy.id, cycle.yz.id, cycle.zx.id].sort());
      expect(result.relationships.length).toBe(3);
      expect(result.entities.length).toBe(3);
    });
  });
});

// `maxDepth` being required (no default) is a TypeScript-level guarantee —
// `TraverseParams.maxDepth` has type `number`, not `number | undefined` — and
// is verified with `bunx tsc --noEmit`, not at test runtime (`bun test`
// strips types rather than type-checking).

describe("isValidRelationshipType", () => {
  test("returns true for a valid relationship type", () => {
    expect(isValidRelationshipType("DEPENDS_ON")).toBe(true);
    expect(isValidRelationshipType("CONTAINS")).toBe(true);
  });

  test("returns false for an invalid string", () => {
    expect(isValidRelationshipType("NOT_A_REAL_TYPE")).toBe(false);
    expect(isValidRelationshipType("")).toBe(false);
  });
});
