// Relationships write-path: versioning + corroboration algorithm.
//
// Identity (same edge vs. a different edge): (from_entity_id, to_entity_id,
// relationship_type). Payload (what "changed" means): the `attributes` jsonb
// column only, compared by exact structural equality — no numeric
// thresholds, no confidence involved. Pure provenance (always additive,
// never triggers versioning): source_system, source_ref, observed_at,
// per-observation confidence, notes. See specs/01-company-brain.md and
// .superpowers/sdd/linear-chasing-feigenbaum/task-4-brief.md for the exact
// algorithm this module implements.

import { sql } from "./db";
import {
  InvalidRelationshipTypeError,
  RelationshipNotFoundError,
} from "./errors";
import { RelationshipType, type Relationship } from "./types";

function isRelationshipType(value: string): value is RelationshipType {
  return (RelationshipType as readonly string[]).includes(value);
}

function assertValidRelationshipType(
  value: string,
): asserts value is RelationshipType {
  if (!isRelationshipType(value)) {
    throw new InvalidRelationshipTypeError(value);
  }
}

interface RelationshipRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  // jsonb columns come back as raw JSON text from Bun's sql driver, not a
  // parsed object — same convention as entities.ts.
  attributes: string;
  // numeric(3,2) comes back as a string from Bun's sql driver (avoids float
  // precision loss); null stays null.
  confidence: string | null;
  status: string;
  valid_from: Date;
  valid_until: Date | null;
  superseded_by: string | null;
  created_at: Date;
}

function rowToRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    relationshipType: row.relationship_type as RelationshipType,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    confidence: row.confidence === null ? null : Number(row.confidence),
    status: row.status as "current" | "historical",
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
  };
}

/**
 * Deep structural equality on parsed JSON values. Used only to compare the
 * `attributes` payload — never confidence, never any other field. Order of
 * object keys does not matter; array order does (arrays are ordered data).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

async function findCurrentRelationship(
  fromEntityId: string,
  toEntityId: string,
  relationshipType: RelationshipType,
): Promise<Relationship | null> {
  const [row] = await sql<RelationshipRow[]>`
    SELECT * FROM relationships
    WHERE from_entity_id = ${fromEntityId}
      AND to_entity_id = ${toEntityId}
      AND relationship_type = ${relationshipType}
      AND status = 'current'
  `;
  return row ? rowToRelationship(row) : null;
}

async function findProvenance(
  relationshipId: string,
  sourceSystem: string,
  sourceRef: string,
): Promise<boolean> {
  const [row] = await sql`
    SELECT id FROM relationship_provenance
    WHERE relationship_id = ${relationshipId}
      AND source_system = ${sourceSystem}
      AND source_ref = ${sourceRef}
  `;
  return row !== undefined;
}

async function insertProvenance(
  tx: typeof sql,
  input: {
    relationshipId: string;
    sourceSystem: string;
    sourceRef: string;
    confidence?: number;
    notes?: string;
  },
): Promise<void> {
  await tx`
    INSERT INTO relationship_provenance
      (relationship_id, source_system, source_ref, confidence, notes)
    VALUES (
      ${input.relationshipId},
      ${input.sourceSystem},
      ${input.sourceRef},
      ${input.confidence ?? null},
      ${input.notes ?? null}
    )
  `;
}

export interface RecordRelationshipObservationInput {
  fromEntityId: string;
  toEntityId: string;
  relationshipType: RelationshipType;
  attributes?: Record<string, unknown>;
  sourceSystem: string;
  sourceRef: string;
  confidence?: number;
  notes?: string;
}

export type RecordRelationshipObservationResult = {
  action: "created" | "retained" | "corroborated" | "versioned";
  relationship: Relationship;
};

/**
 * The core versioning/corroboration write-path. See module header + the
 * task brief for the full algorithm spec. Summary of the 4 outcomes:
 *
 * - created: no current row for the identity triple existed yet.
 * - retained: current row exists, attributes unchanged, and this exact
 *   (source_system, source_ref) already corroborated it — pure no-op.
 * - corroborated: current row exists, attributes unchanged, but this is a
 *   new (source_system, source_ref) — adds provenance only.
 * - versioned: current row exists with different attributes — old row is
 *   superseded (historical) and a new current row is inserted, atomically.
 */
export async function recordRelationshipObservation(
  obs: RecordRelationshipObservationInput,
): Promise<RecordRelationshipObservationResult> {
  // Step 1: app-level defense in depth, before any DB write.
  assertValidRelationshipType(obs.relationshipType);

  const attributes = obs.attributes ?? {};

  // Step 2: look up the current row for the identity triple.
  const current = await findCurrentRelationship(
    obs.fromEntityId,
    obs.toEntityId,
    obs.relationshipType,
  );

  if (!current) {
    // Step 3: no current row → insert relationship + provenance, atomically.
    const relationship = await sql.begin(async (tx) => {
      const [row] = await tx<RelationshipRow[]>`
        INSERT INTO relationships
          (from_entity_id, to_entity_id, relationship_type, attributes, confidence)
        VALUES (
          ${obs.fromEntityId},
          ${obs.toEntityId},
          ${obs.relationshipType},
          ${JSON.stringify(attributes)}::jsonb,
          ${obs.confidence ?? null}
        )
        RETURNING *
      `;
      await insertProvenance(tx, {
        relationshipId: row.id,
        sourceSystem: obs.sourceSystem,
        sourceRef: obs.sourceRef,
        confidence: obs.confidence,
        notes: obs.notes,
      });
      return rowToRelationship(row);
    });

    return { action: "created", relationship };
  }

  const unchanged = deepEqual(current.attributes, attributes);

  if (unchanged) {
    // Step 4: current row exists, same attributes payload.
    const alreadyObserved = await findProvenance(
      current.id,
      obs.sourceSystem,
      obs.sourceRef,
    );

    if (alreadyObserved) {
      // Idempotent re-ingestion: no-op.
      return { action: "retained", relationship: current };
    }

    // New source corroborating the same relationship: provenance only,
    // relationship row untouched. Single statement — no transaction needed.
    await insertProvenance(sql, {
      relationshipId: current.id,
      sourceSystem: obs.sourceSystem,
      sourceRef: obs.sourceRef,
      confidence: obs.confidence,
      notes: obs.notes,
    });

    return { action: "corroborated", relationship: current };
  }

  // Step 5: current row exists, different attributes payload → version it,
  // atomically: insert new current row, mark old row historical, insert
  // provenance against the new row.
  const relationship = await sql.begin(async (tx) => {
    // Mark the old row historical FIRST: the partial unique index allows at
    // most one 'current' row per identity triple, so inserting the new
    // current row before retiring the old one would violate it.
    await tx`
      UPDATE relationships
      SET status = 'historical', valid_until = now()
      WHERE id = ${current.id}
    `;

    const [newRow] = await tx<RelationshipRow[]>`
      INSERT INTO relationships
        (from_entity_id, to_entity_id, relationship_type, attributes, confidence)
      VALUES (
        ${obs.fromEntityId},
        ${obs.toEntityId},
        ${obs.relationshipType},
        ${JSON.stringify(attributes)}::jsonb,
        ${obs.confidence ?? null}
      )
      RETURNING *
    `;

    await tx`
      UPDATE relationships
      SET superseded_by = ${newRow.id}
      WHERE id = ${current.id}
    `;

    await insertProvenance(tx, {
      relationshipId: newRow.id,
      sourceSystem: obs.sourceSystem,
      sourceRef: obs.sourceRef,
      confidence: obs.confidence,
      notes: obs.notes,
    });

    return rowToRelationship(newRow);
  });

  return { action: "versioned", relationship };
}

export interface SupersedeRelationshipInput {
  oldRelationshipId: string;
  newObservation: {
    toEntityId?: string;
    relationshipType?: RelationshipType;
    attributes?: Record<string, unknown>;
    sourceSystem: string;
    sourceRef: string;
    confidence?: number;
  };
}

/**
 * Explicit escape hatch for a caller that already knows two
 * different-identity edges represent the same functional slot over time
 * (e.g. a service was renamed, so the edge's `to_entity_id` changes but it's
 * conceptually "the same" relationship). Same transactional shape as the
 * versioned path in recordRelationshipObservation, except the new row's
 * identity fields are taken from `newObservation` (falling back to the old
 * row's identity fields when not supplied) rather than being forced
 * identical to the old row.
 */
export async function supersedeRelationship(
  input: SupersedeRelationshipInput,
): Promise<Relationship> {
  const { oldRelationshipId, newObservation } = input;

  if (newObservation.relationshipType !== undefined) {
    assertValidRelationshipType(newObservation.relationshipType);
  }

  const [oldRow] = await sql<RelationshipRow[]>`
    SELECT * FROM relationships
    WHERE id = ${oldRelationshipId} AND status = 'current'
  `;
  if (!oldRow) {
    throw new RelationshipNotFoundError(oldRelationshipId);
  }
  const oldRelationship = rowToRelationship(oldRow);

  const toEntityId = newObservation.toEntityId ?? oldRelationship.toEntityId;
  const relationshipType =
    newObservation.relationshipType ?? oldRelationship.relationshipType;
  const attributes = newObservation.attributes ?? {};

  const relationship = await sql.begin(async (tx) => {
    // Mark the old row historical FIRST: if the new identity happens to
    // match the old one, the partial unique index allows at most one
    // 'current' row per identity triple, so the old row must be retired
    // before the new current row is inserted.
    await tx`
      UPDATE relationships
      SET status = 'historical', valid_until = now()
      WHERE id = ${oldRelationship.id}
    `;

    const [newRow] = await tx<RelationshipRow[]>`
      INSERT INTO relationships
        (from_entity_id, to_entity_id, relationship_type, attributes, confidence)
      VALUES (
        ${oldRelationship.fromEntityId},
        ${toEntityId},
        ${relationshipType},
        ${JSON.stringify(attributes)}::jsonb,
        ${newObservation.confidence ?? null}
      )
      RETURNING *
    `;

    await tx`
      UPDATE relationships
      SET superseded_by = ${newRow.id}
      WHERE id = ${oldRelationship.id}
    `;

    await insertProvenance(tx, {
      relationshipId: newRow.id,
      sourceSystem: newObservation.sourceSystem,
      sourceRef: newObservation.sourceRef,
      confidence: newObservation.confidence,
    });

    return rowToRelationship(newRow);
  });

  return relationship;
}

/**
 * In-place update of `confidence` on the current row only. Never touches
 * status/valid_from/valid_until/superseded_by — this is not a versioning
 * event. `reason` is accepted for the caller's own bookkeeping; there is no
 * schema column to persist it against without inventing one beyond Task 2's
 * DDL, so it is intentionally not persisted here.
 */
export async function updateRelationshipConfidence(
  id: string,
  confidence: number,
  reason: string,
): Promise<Relationship> {
  void reason; // accepted for the caller's bookkeeping only — see doc comment above.
  const [row] = await sql<RelationshipRow[]>`
    UPDATE relationships
    SET confidence = ${confidence}
    WHERE id = ${id}
    RETURNING *
  `;
  if (!row) {
    throw new RelationshipNotFoundError(id);
  }
  return rowToRelationship(row);
}
