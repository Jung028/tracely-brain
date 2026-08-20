// Read-only query interface over the `relationships` / `relationship_provenance`
// / `entities` tables. Consumed by a later module (03, Investigation Agent —
// not part of this plan) to retrieve context from the Brain.
//
// Pure data access only: no hypothesis generation, no evidence scoring, no
// investigation logic. See specs/01-company-brain.md and
// docs/company-brain-query-interface.md for the exact signatures and the
// recursive CTE this module implements.

import { sql } from "./db";
import { Domain, RelationshipType } from "./types";
import type { Entity, Provenance, Relationship } from "./types";

// ---------------------------------------------------------------------------
// Row shapes + converters. Each module in this codebase defines its own
// private row shape/converter rather than sharing one (see entities.ts,
// relationships.ts) — following that convention here.
// ---------------------------------------------------------------------------

interface EntityRow {
  id: string;
  domain: string;
  entity_type: string;
  name: string;
  source_system: string;
  source_ref: string;
  attributes: string;
  created_at: Date;
  updated_at: Date;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    domain: row.domain as Domain,
    entityType: row.entity_type,
    name: row.name,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RelationshipRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  attributes: string;
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

interface ProvenanceRow {
  id: string;
  relationship_id: string;
  source_system: string;
  source_ref: string;
  confidence: string | null;
  observed_at: Date;
  notes: string | null;
  created_at: Date;
}

function rowToProvenance(row: ProvenanceRow): Provenance {
  return {
    id: row.id,
    relationshipId: row.relationship_id,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    confidence: row.confidence === null ? null : Number(row.confidence),
    observedAt: row.observed_at,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// isValidRelationshipType
// ---------------------------------------------------------------------------

// A malformed id string sent straight to Postgres as a `uuid` parameter
// fails with raw error code 22P02 ("invalid input syntax for type uuid")
// instead of a graceful "not found" result. See entities.ts for the same
// check applied to getEntity — duplicated here rather than shared, per this
// file's convention of each module owning its own small helpers.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isWellFormedUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isValidRelationshipType(
  value: string,
): value is RelationshipType {
  return (RelationshipType as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// queryRelationships
// ---------------------------------------------------------------------------

export interface QueryRelationshipsFilter {
  /** Matches either endpoint entity's domain. */
  domain?: Domain;
  relationshipType?: RelationshipType | RelationshipType[];
  /** Default 'current'. Ignored when `validAt` is set. */
  status?: "current" | "historical" | "any";
  /**
   * When set, overrides status filtering with
   * valid_from <= validAt AND (valid_until IS NULL OR valid_until > validAt).
   */
  validAt?: Date;
  fromEntityId?: string;
  toEntityId?: string;
  limit?: number;
}

export async function queryRelationships(
  filter: QueryRelationshipsFilter,
): Promise<Relationship[]> {
  const domainFilter = filter.domain ?? null;
  const types =
    filter.relationshipType === undefined
      ? null
      : Array.isArray(filter.relationshipType)
        ? filter.relationshipType.length > 0
          ? filter.relationshipType
          : null
        : [filter.relationshipType];
  // Bun.sql needs an explicit Postgres array type via `sql.array(...)` — a
  // plain JS array interpolated as `${arr}` is sent as a comma-joined string,
  // not a Postgres array literal, and fails with "malformed array literal"
  // (verified empirically against a live Postgres instance).
  const typesFilter = types === null ? null : sql.array(types, "text");
  const validAt = filter.validAt ?? null;
  // `statusFilter` is only ever consulted when `validAt` is null (see the
  // mutually-exclusive OR below) — validAt overrides status entirely.
  const statusFilter =
    filter.status === "any" ? null : (filter.status ?? "current");
  const fromEntityId = filter.fromEntityId ?? null;
  const toEntityId = filter.toEntityId ?? null;
  const limit = filter.limit ?? null;

  const rows = await sql<RelationshipRow[]>`
    SELECT r.* FROM relationships r
    WHERE (
        ${domainFilter}::text IS NULL OR EXISTS (
          SELECT 1 FROM entities e
          WHERE e.id IN (r.from_entity_id, r.to_entity_id) AND e.domain = ${domainFilter}
        )
      )
      AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
      AND (
        (
          ${validAt}::timestamptz IS NOT NULL
          AND r.valid_from <= ${validAt}
          AND (r.valid_until IS NULL OR r.valid_until > ${validAt})
        )
        OR (
          ${validAt}::timestamptz IS NULL
          AND (${statusFilter}::text IS NULL OR r.status = ${statusFilter})
        )
      )
      AND (${fromEntityId}::uuid IS NULL OR r.from_entity_id = ${fromEntityId})
      AND (${toEntityId}::uuid IS NULL OR r.to_entity_id = ${toEntityId})
    ORDER BY r.created_at, r.id
    LIMIT ${limit}
  `;

  return rows.map(rowToRelationship);
}

// ---------------------------------------------------------------------------
// getRelationshipHistory
// ---------------------------------------------------------------------------

export async function getRelationshipHistory(
  fromEntityId: string,
  toEntityId: string,
  relationshipType: RelationshipType,
): Promise<Relationship[]> {
  const rows = await sql<RelationshipRow[]>`
    SELECT * FROM relationships
    WHERE from_entity_id = ${fromEntityId}
      AND to_entity_id = ${toEntityId}
      AND relationship_type = ${relationshipType}
    ORDER BY valid_from ASC
  `;

  return rows.map(rowToRelationship);
}

// ---------------------------------------------------------------------------
// getProvenance
// ---------------------------------------------------------------------------

export async function getProvenance(
  relationshipId: string,
): Promise<Provenance[]> {
  // A malformed id can never match a row — short-circuit before it reaches
  // Postgres as a `uuid` parameter and raises 22P02 instead of this
  // function's normal "nothing found" convention (an empty array).
  if (!isWellFormedUuid(relationshipId)) {
    return [];
  }

  const rows = await sql<ProvenanceRow[]>`
    SELECT * FROM relationship_provenance
    WHERE relationship_id = ${relationshipId}
    ORDER BY observed_at ASC
  `;

  return rows.map(rowToProvenance);
}

// ---------------------------------------------------------------------------
// traverse
// ---------------------------------------------------------------------------

export interface TraverseParams {
  startEntityId: string;
  /** Omit = any type. */
  relationshipTypes?: RelationshipType[];
  /**
   * Default 'outgoing'.
   *
   * `'both'` unions two direction-consistent walks from the start entity —
   * an outgoing-only walk (edges followed forward) and an incoming-only walk
   * (edges followed backward) — then depth-collapses the combined result.
   * It is NOT full undirected graph reachability: neither walk ever changes
   * direction mid-path, so a node reachable only via a mixed forward/backward
   * path is invisible at any depth. Example: given
   * `ServiceA --DEPENDS_ON--> DB <--DEPENDS_ON-- ServiceB`,
   * `traverse({ startEntityId: ServiceA.id, direction: 'both' })` returns the
   * `ServiceA -> DB` edge but never reaches `ServiceB`, because there is no
   * all-outgoing or all-incoming path from A to B — only a path that goes
   * out then back in, which this union does not follow.
   */
  direction?: "outgoing" | "incoming" | "both";
  /** REQUIRED — no default. Caller must always bound recursion explicitly. */
  maxDepth: number;
  /** Default: current relationships only. */
  validAt?: Date;
}

export interface TraverseResult {
  entities: Entity[];
  relationships: (Relationship & { depth: number })[];
}

interface WalkRow extends RelationshipRow {
  depth: number;
}

export async function traverse(
  params: TraverseParams,
): Promise<TraverseResult> {
  const { startEntityId, maxDepth } = params;

  // maxDepth is REQUIRED but not otherwise validated by the type system — a
  // caller passing 0 or a negative number would still reach the recursive
  // CTE below, where only the *recursive* term checks `depth < maxDepth`;
  // the seed term has no such check, so 0/negative would still return one
  // hop instead of the empty result the caller asked for. Guard it here
  // instead of relying on SQL to express "not a positive integer".
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    return { entities: [], relationships: [] };
  }

  // Same rationale as getProvenance above: a malformed startEntityId can
  // never match a row, so short-circuit before it reaches Postgres as a
  // `uuid` parameter and raises 22P02.
  if (!isWellFormedUuid(startEntityId)) {
    return { entities: [], relationships: [] };
  }

  const types =
    params.relationshipTypes && params.relationshipTypes.length > 0
      ? params.relationshipTypes
      : null;
  // See queryRelationships for why array params need sql.array(...).
  const typesFilter = types === null ? null : sql.array(types, "text");
  const direction = params.direction ?? "outgoing";
  const validAt = params.validAt ?? null;

  let rows: WalkRow[];

  if (direction === "outgoing") {
    rows = await sql<WalkRow[]>`
      WITH RECURSIVE walk AS (
        SELECT r.*, 1 AS depth, ARRAY[r.from_entity_id, r.to_entity_id] AS visited
        FROM relationships r
        WHERE r.from_entity_id = ${startEntityId}
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
        UNION ALL
        SELECT r.*, w.depth + 1, w.visited || r.to_entity_id
        FROM relationships r
        JOIN walk w ON r.from_entity_id = w.to_entity_id
        WHERE w.depth < ${maxDepth}
          AND NOT (r.to_entity_id = ANY(w.visited))
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
      )
      SELECT DISTINCT ON (id) * FROM walk ORDER BY id, depth
    `;
  } else if (direction === "incoming") {
    rows = await sql<WalkRow[]>`
      WITH RECURSIVE walk AS (
        SELECT r.*, 1 AS depth, ARRAY[r.to_entity_id, r.from_entity_id] AS visited
        FROM relationships r
        WHERE r.to_entity_id = ${startEntityId}
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
        UNION ALL
        SELECT r.*, w.depth + 1, w.visited || r.from_entity_id
        FROM relationships r
        JOIN walk w ON r.to_entity_id = w.from_entity_id
        WHERE w.depth < ${maxDepth}
          AND NOT (r.from_entity_id = ANY(w.visited))
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
      )
      SELECT DISTINCT ON (id) * FROM walk ORDER BY id, depth
    `;
  } else {
    // 'both': independent outgoing and incoming recursive walks from the
    // same start entity, unioned together, then depth-collapsed once at the
    // end (see task-5-brief.md: "a UNION of the outgoing and incoming
    // queries before depth-collapsing"). Each walk is self-contained (never
    // references the other), which is why two separate named CTEs — rather
    // than one CTE mixing both directions — are used: it avoids the outgoing
    // recursive term ever joining against rows the incoming walk produced
    // (and vice versa), which would blend the two directions mid-path
    // instead of keeping them as two straight walks from the start node.
    rows = await sql<WalkRow[]>`
      WITH RECURSIVE
      walk_out AS (
        SELECT r.*, 1 AS depth, ARRAY[r.from_entity_id, r.to_entity_id] AS visited
        FROM relationships r
        WHERE r.from_entity_id = ${startEntityId}
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
        UNION ALL
        SELECT r.*, w.depth + 1, w.visited || r.to_entity_id
        FROM relationships r
        JOIN walk_out w ON r.from_entity_id = w.to_entity_id
        WHERE w.depth < ${maxDepth}
          AND NOT (r.to_entity_id = ANY(w.visited))
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
      ),
      walk_in AS (
        SELECT r.*, 1 AS depth, ARRAY[r.to_entity_id, r.from_entity_id] AS visited
        FROM relationships r
        WHERE r.to_entity_id = ${startEntityId}
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
        UNION ALL
        SELECT r.*, w.depth + 1, w.visited || r.from_entity_id
        FROM relationships r
        JOIN walk_in w ON r.to_entity_id = w.from_entity_id
        WHERE w.depth < ${maxDepth}
          AND NOT (r.from_entity_id = ANY(w.visited))
          AND (
            (${validAt}::timestamptz IS NOT NULL AND r.valid_from <= ${validAt} AND (r.valid_until IS NULL OR r.valid_until > ${validAt}))
            OR (${validAt}::timestamptz IS NULL AND r.status = 'current')
          )
          AND (${typesFilter}::text[] IS NULL OR r.relationship_type = ANY(${typesFilter}))
      )
      SELECT DISTINCT ON (id) * FROM (
        SELECT * FROM walk_out
        UNION ALL
        SELECT * FROM walk_in
      ) combined
      ORDER BY id, depth
    `;
  }

  const relationships = rows.map((row) => ({
    ...rowToRelationship(row),
    depth: row.depth,
  }));

  const entityIds = Array.from(
    new Set(relationships.flatMap((r) => [r.fromEntityId, r.toEntityId])),
  );

  const entities =
    entityIds.length === 0
      ? []
      : (
          await sql<EntityRow[]>`SELECT * FROM entities WHERE id = ANY(${sql.array(entityIds, "uuid")}::uuid[])`
        ).map(rowToEntity);

  return { entities, relationships };
}
