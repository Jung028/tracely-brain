import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { RelationshipNotFoundError } from "../src/brain/errors";
import { InvalidRelationshipTypeError } from "../src/brain/errors";
import {
  recordRelationshipObservation,
  supersedeRelationship,
  updateRelationshipConfidence,
} from "../src/brain/relationships";
import { upsertEntity } from "../src/brain/entities";
import type { Relationship } from "../src/brain/types";
import { truncateAll } from "./db-helpers";

afterEach(async () => {
  await truncateAll();
});

/**
 * Minimal test-local lookup — the full query interface lands in Task 5.
 * Fetches a relationship row (current or historical) directly by id.
 */
async function getRelationshipById(id: string): Promise<Relationship | null> {
  const [row] = await sql`SELECT * FROM relationships WHERE id = ${id}`;
  if (!row) return null;
  return {
    id: row.id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    relationshipType: row.relationship_type,
    attributes:
      typeof row.attributes === "string"
        ? JSON.parse(row.attributes)
        : row.attributes,
    confidence: row.confidence === null ? null : Number(row.confidence),
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  };
}

async function getProvenanceRows(relationshipId: string) {
  return sql`SELECT * FROM relationship_provenance WHERE relationship_id = ${relationshipId}`;
}

async function makeEntityPair(suffix: string) {
  const from = await upsertEntity({
    domain: "Code",
    entityType: "Repository",
    name: `from-${suffix}`,
    sourceSystem: "manual",
    sourceRef: `test:rel:${suffix}:from`,
  });
  const to = await upsertEntity({
    domain: "Runtime",
    entityType: "Service",
    name: `to-${suffix}`,
    sourceSystem: "manual",
    sourceRef: `test:rel:${suffix}:to`,
  });
  return { from, to };
}

describe("recordRelationshipObservation", () => {
  test("CRUD: fresh identity creates a relationship with full metadata + provenance", async () => {
    const { from, to } = await makeEntityPair("crud");

    const result = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "DEPENDS_ON",
      attributes: { criticality: "high" },
      sourceSystem: "github",
      sourceRef: "github:acme/repo@sha1",
      confidence: 0.9,
      notes: "initial observation",
    });

    expect(result.action).toBe("created");
    expect(result.relationship.fromEntityId).toBe(from.id);
    expect(result.relationship.toEntityId).toBe(to.id);
    expect(result.relationship.relationshipType).toBe("DEPENDS_ON");
    expect(result.relationship.attributes).toEqual({ criticality: "high" });
    expect(result.relationship.confidence).toBe(0.9);
    expect(result.relationship.status).toBe("current");
    expect(result.relationship.validFrom).toBeInstanceOf(Date);
    expect(result.relationship.validUntil).toBeNull();
    expect(result.relationship.supersededBy).toBeNull();
    expect(result.relationship.createdAt).toBeInstanceOf(Date);

    const provenance = await getProvenanceRows(result.relationship.id);
    expect(provenance.length).toBe(1);
    expect(provenance[0]?.source_system).toBe("github");
    expect(provenance[0]?.source_ref).toBe("github:acme/repo@sha1");
    expect(Number(provenance[0]?.confidence)).toBe(0.9);
    expect(provenance[0]?.notes).toBe("initial observation");
  });

  test("versioning: same identity, different attributes → versioned, old row historical + superseded_by, new row current", async () => {
    const { from, to } = await makeEntityPair("version");

    const first = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "CALLS",
      attributes: { protocol: "http" },
      sourceSystem: "datadog",
      sourceRef: "datadog:trace-1",
    });
    expect(first.action).toBe("created");

    const second = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "CALLS",
      attributes: { protocol: "grpc" },
      sourceSystem: "datadog",
      sourceRef: "datadog:trace-2",
    });

    expect(second.action).toBe("versioned");
    expect(second.relationship.id).not.toBe(first.relationship.id);
    expect(second.relationship.status).toBe("current");
    expect(second.relationship.attributes).toEqual({ protocol: "grpc" });
    expect(second.relationship.validUntil).toBeNull();
    expect(second.relationship.supersededBy).toBeNull();

    const oldRow = await getRelationshipById(first.relationship.id);
    expect(oldRow).not.toBeNull();
    expect(oldRow?.status).toBe("historical");
    expect(oldRow?.validUntil).toBeInstanceOf(Date);
    expect(oldRow?.supersededBy).toBe(second.relationship.id);

    const newRow = await getRelationshipById(second.relationship.id);
    expect(newRow).not.toBeNull();
    expect(newRow?.status).toBe("current");

    // Provenance for the versioning observation is against the NEW row only.
    const newProvenance = await getProvenanceRows(second.relationship.id);
    expect(newProvenance.length).toBe(1);
    expect(newProvenance[0]?.source_ref).toBe("datadog:trace-2");
  });

  test("multi-source corroboration: same identity + same attributes, new source → corroborated, same relationship id, no duplicate row", async () => {
    const { from, to } = await makeEntityPair("corroborate");

    const first = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "READS",
      attributes: { table: "orders" },
      sourceSystem: "postgres",
      sourceRef: "postgres:query-1",
    });
    expect(first.action).toBe("created");

    const second = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "READS",
      attributes: { table: "orders" },
      sourceSystem: "slack",
      sourceRef: "slack:thread-42",
    });

    expect(second.action).toBe("corroborated");
    expect(second.relationship.id).toBe(first.relationship.id);

    const provenance = await getProvenanceRows(first.relationship.id);
    expect(provenance.length).toBe(2);

    const sources = provenance.map((p: any) => p.source_system).sort();
    expect(sources).toEqual(["postgres", "slack"]);

    // Confirm no duplicate relationship row was created for this identity.
    const allRows = await sql`
      SELECT id FROM relationships
      WHERE from_entity_id = ${from.id} AND to_entity_id = ${to.id} AND relationship_type = 'READS'
    `;
    expect(allRows.length).toBe(1);

    // Re-observing the exact same (sourceSystem, sourceRef) again → retained, idempotent.
    const third = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "READS",
      attributes: { table: "orders" },
      sourceSystem: "slack",
      sourceRef: "slack:thread-42",
    });

    expect(third.action).toBe("retained");
    expect(third.relationship.id).toBe(first.relationship.id);

    const provenanceAfterRetain = await getProvenanceRows(first.relationship.id);
    expect(provenanceAfterRetain.length).toBe(2); // no duplicate provenance row
  });

  test("confidence-only change never triggers versioning: same attributes, different confidence, new source → corroborated", async () => {
    const { from, to } = await makeEntityPair("confidence-not-versioning");

    const first = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "READS",
      attributes: { table: "invoices" },
      sourceSystem: "postgres",
      sourceRef: "postgres:query-conf-1",
      confidence: 0.4,
    });
    expect(first.action).toBe("created");
    expect(first.relationship.confidence).toBe(0.4);

    // Same identity, same attributes, DIFFERENT confidence, new
    // (sourceSystem, sourceRef) — must be corroboration, not versioning.
    // Confidence is explicitly excluded from change detection (see brief).
    const second = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "READS",
      attributes: { table: "invoices" },
      sourceSystem: "slack",
      sourceRef: "slack:thread-conf-99",
      confidence: 0.95,
    });

    expect(second.action).toBe("corroborated");
    expect(second.relationship.id).toBe(first.relationship.id);
    // Corroboration never touches the relationship row: confidence still
    // reflects the ORIGINAL observation, not the new one.
    expect(second.relationship.confidence).toBe(0.4);

    const currentRow = await getRelationshipById(first.relationship.id);
    expect(currentRow?.status).toBe("current");
    expect(currentRow?.confidence).toBe(0.4);

    // No versioning happened: only one relationship row exists for this
    // identity, and it's still 'current'.
    const allRows = await sql`
      SELECT id, status FROM relationships
      WHERE from_entity_id = ${from.id} AND to_entity_id = ${to.id} AND relationship_type = 'READS'
    `;
    expect(allRows.length).toBe(1);
    expect(allRows[0]?.status).toBe("current");
  });

  test("deep-equality on nested attributes ignores object key order (not a naive JSON.stringify compare)", async () => {
    const { from, to } = await makeEntityPair("deepequal-nested");

    const first = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "DEPENDS_ON",
      attributes: {
        criticality: "high",
        meta: { region: "us-east-1", tier: 1 },
      },
      sourceSystem: "manual",
      sourceRef: "test:deepequal-nested:1",
    });
    expect(first.action).toBe("created");

    // Same nested structure, but with keys reordered at both the top level
    // and inside the nested object — must still be treated as unchanged.
    const second = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "DEPENDS_ON",
      attributes: {
        meta: { tier: 1, region: "us-east-1" },
        criticality: "high",
      },
      sourceSystem: "manual",
      sourceRef: "test:deepequal-nested:2",
    });

    expect(second.action).toBe("corroborated");
    expect(second.relationship.id).toBe(first.relationship.id);
  });

  test("rejects a relationship type outside the controlled vocabulary before any DB write", async () => {
    const { from, to } = await makeEntityPair("invalid-type");

    await expect(
      recordRelationshipObservation({
        fromEntityId: from.id,
        toEntityId: to.id,
        // deliberately invalid — cast through unknown to bypass the TS literal type
        relationshipType: "NOT_A_REAL_TYPE" as unknown as Parameters<
          typeof recordRelationshipObservation
        >[0]["relationshipType"],
        sourceSystem: "manual",
        sourceRef: "test:invalid-type",
      }),
    ).rejects.toThrow(InvalidRelationshipTypeError);

    const allRows = await sql`
      SELECT id FROM relationships
      WHERE from_entity_id = ${from.id} AND to_entity_id = ${to.id}
    `;
    expect(allRows.length).toBe(0);

    const allProvenance = await sql`SELECT id FROM relationship_provenance`;
    expect(allProvenance.length).toBe(0);
  });
});

describe("supersedeRelationship", () => {
  test("creates a new current row with the new identity and marks the old row historical", async () => {
    const { from, to } = await makeEntityPair("supersede");
    const newTo = await upsertEntity({
      domain: "Runtime",
      entityType: "Service",
      name: "renamed-service",
      sourceSystem: "manual",
      sourceRef: "test:rel:supersede:new-to",
    });

    const created = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "DEPENDS_ON",
      attributes: { criticality: "medium" },
      sourceSystem: "manual",
      sourceRef: "test:supersede:initial",
    });

    const superseded = await supersedeRelationship({
      oldRelationshipId: created.relationship.id,
      newObservation: {
        toEntityId: newTo.id,
        attributes: { criticality: "medium" },
        sourceSystem: "manual",
        sourceRef: "test:supersede:rename",
      },
    });

    expect(superseded.id).not.toBe(created.relationship.id);
    expect(superseded.status).toBe("current");
    expect(superseded.fromEntityId).toBe(from.id);
    expect(superseded.toEntityId).toBe(newTo.id);
    expect(superseded.relationshipType).toBe("DEPENDS_ON");

    const oldRow = await getRelationshipById(created.relationship.id);
    expect(oldRow?.status).toBe("historical");
    expect(oldRow?.supersededBy).toBe(superseded.id);
    expect(oldRow?.validUntil).toBeInstanceOf(Date);

    const provenance = await getProvenanceRows(superseded.id);
    expect(provenance.length).toBe(1);
    expect(provenance[0]?.source_ref).toBe("test:supersede:rename");
  });

  test("throws RelationshipNotFoundError when oldRelationshipId doesn't resolve to a current row", async () => {
    const missingId = "00000000-0000-0000-0000-000000000000";

    await expect(
      supersedeRelationship({
        oldRelationshipId: missingId,
        newObservation: {
          sourceSystem: "manual",
          sourceRef: "test:supersede:missing",
        },
      }),
    ).rejects.toThrow(RelationshipNotFoundError);
  });

  test("throws RelationshipNotFoundError when oldRelationshipId is already historical", async () => {
    const { from, to } = await makeEntityPair("supersede-historical");

    const created = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "CALLS",
      attributes: { v: 1 },
      sourceSystem: "manual",
      sourceRef: "test:supersede-historical:1",
    });

    // Version it once so `created` becomes historical.
    await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "CALLS",
      attributes: { v: 2 },
      sourceSystem: "manual",
      sourceRef: "test:supersede-historical:2",
    });

    await expect(
      supersedeRelationship({
        oldRelationshipId: created.relationship.id,
        newObservation: {
          sourceSystem: "manual",
          sourceRef: "test:supersede-historical:3",
        },
      }),
    ).rejects.toThrow(RelationshipNotFoundError);
  });
});

describe("updateRelationshipConfidence", () => {
  test("updates confidence in place without changing status/validFrom/validUntil", async () => {
    const { from, to } = await makeEntityPair("confidence");

    const created = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "OWNED_BY",
      attributes: { team: "payments" },
      sourceSystem: "manual",
      sourceRef: "test:confidence:1",
      confidence: 0.5,
    });

    const updated = await updateRelationshipConfidence(
      created.relationship.id,
      0.95,
      "manual review confirmed ownership",
    );

    expect(updated.id).toBe(created.relationship.id);
    expect(updated.confidence).toBe(0.95);
    expect(updated.status).toBe(created.relationship.status);
    expect(updated.validFrom.getTime()).toBe(
      created.relationship.validFrom.getTime(),
    );
    expect(updated.validUntil).toBeNull();
    expect(updated.attributes).toEqual(created.relationship.attributes);
  });

  test("throws RelationshipNotFoundError for a nonexistent id", async () => {
    const missingId = "00000000-0000-0000-0000-000000000000";

    await expect(
      updateRelationshipConfidence(missingId, 0.5, "n/a"),
    ).rejects.toThrow(RelationshipNotFoundError);
  });

  test("throws RelationshipNotFoundError when the id resolves to a historical (superseded) row", async () => {
    const { from, to } = await makeEntityPair("confidence-historical");

    const created = await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "OWNED_BY",
      attributes: { team: "payments" },
      sourceSystem: "manual",
      sourceRef: "test:confidence-historical:1",
      confidence: 0.5,
    });

    // Version it so `created` becomes historical.
    await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType: "OWNED_BY",
      attributes: { team: "risk" },
      sourceSystem: "manual",
      sourceRef: "test:confidence-historical:2",
    });

    const historicalRow = await getRelationshipById(created.relationship.id);
    expect(historicalRow?.status).toBe("historical");

    await expect(
      updateRelationshipConfidence(
        created.relationship.id,
        0.99,
        "should not apply to a historical row",
      ),
    ).rejects.toThrow(RelationshipNotFoundError);

    // Confirm the historical row's confidence was NOT silently mutated.
    const stillHistorical = await getRelationshipById(created.relationship.id);
    expect(stillHistorical?.confidence).toBe(0.5);
  });
});
