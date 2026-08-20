import { sql } from "./db";
import { EntityNotFoundError } from "./errors";
import { Domain, type Entity } from "./types";

function isDomain(value: string): value is Domain {
  return (Domain as readonly string[]).includes(value);
}

// A malformed id string sent straight to Postgres as a `uuid` parameter
// fails with raw error code 22P02 ("invalid input syntax for type uuid")
// instead of the module's typed EntityNotFoundError. Validating the shape
// up front lets a bad id resolve to the same typed "not found" outcome as
// a well-formed id that simply doesn't exist, without a try/catch on every
// call site.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isWellFormedUuid(value: string): boolean {
  return UUID_RE.test(value);
}

interface EntityRow {
  id: string;
  domain: string;
  entity_type: string;
  name: string;
  source_system: string;
  source_ref: string;
  // Bun's sql driver returns jsonb columns as raw JSON text, not a parsed
  // object — verified empirically against a live Postgres instance.
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

export async function upsertEntity(input: {
  domain: Domain;
  entityType: string;
  name: string;
  sourceSystem: string;
  sourceRef: string;
  attributes?: Record<string, unknown>;
}): Promise<Entity> {
  if (!isDomain(input.domain)) {
    // Defense in depth alongside the DB CHECK constraint (see migrations/0001_init.sql).
    throw new Error(
      `Invalid domain: ${JSON.stringify(input.domain)}. Must be one of: ${Domain.join(", ")}`,
    );
  }

  const attributesJson = JSON.stringify(input.attributes ?? {});

  const [row] = await sql<EntityRow[]>`
    INSERT INTO entities (domain, entity_type, name, source_system, source_ref, attributes)
    VALUES (
      ${input.domain},
      ${input.entityType},
      ${input.name},
      ${input.sourceSystem},
      ${input.sourceRef},
      ${attributesJson}::jsonb
    )
    ON CONFLICT (source_system, source_ref) DO UPDATE SET
      domain = EXCLUDED.domain,
      entity_type = EXCLUDED.entity_type,
      name = EXCLUDED.name,
      attributes = EXCLUDED.attributes,
      updated_at = now()
    RETURNING *
  `;

  return rowToEntity(row);
}

export async function getEntity(id: string): Promise<Entity> {
  if (!isWellFormedUuid(id)) {
    throw new EntityNotFoundError(id);
  }
  const [row] = await sql<EntityRow[]>`SELECT * FROM entities WHERE id = ${id}`;
  if (!row) {
    throw new EntityNotFoundError(id);
  }
  return rowToEntity(row);
}

export async function findEntities(filter: {
  domain?: Domain;
  entityType?: string;
}): Promise<Entity[]> {
  const domainFilter = filter.domain ?? null;
  const entityTypeFilter = filter.entityType ?? null;

  const rows = await sql<EntityRow[]>`
    SELECT * FROM entities
    WHERE (${domainFilter}::text IS NULL OR domain = ${domainFilter})
      AND (${entityTypeFilter}::text IS NULL OR entity_type = ${entityTypeFilter})
    ORDER BY created_at
  `;

  return rows.map(rowToEntity);
}
