import { afterEach, expect, test } from "bun:test";
import { sql } from "bun";
import { truncateAll } from "./db-helpers";

afterEach(async () => {
  await truncateAll();
});

test("entities, relationships, and relationship_provenance tables exist", async () => {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('entities', 'relationships', 'relationship_provenance')
  `;
  const tableNames = rows.map((row: { table_name: string }) => row.table_name).sort();

  expect(tableNames).toEqual(["entities", "relationship_provenance", "relationships"]);
});

test("entities.domain CHECK constraint rejects a domain outside the controlled vocabulary at the DB layer", async () => {
  let error: any;
  try {
    await sql`
      INSERT INTO entities (domain, entity_type, name, source_system, source_ref)
      VALUES ('NotARealDomain', 'Repository', 'test-entity', 'manual', 'test:domain-check')
    `;
  } catch (e) {
    error = e;
  }

  expect(error).toBeDefined();
  // Bun's PostgresError puts the Postgres SQLSTATE in `errno`, not `code`
  // (`code` is Bun's own error-class code, e.g. "ERR_POSTGRES_SERVER_ERROR").
  expect(error.errno).toBe("23514"); // check_violation
});

test("relationships.relationship_type CHECK constraint rejects a type outside the controlled vocabulary at the DB layer", async () => {
  const [fromEntity] = await sql`
    INSERT INTO entities (domain, entity_type, name, source_system, source_ref)
    VALUES ('Code', 'Repository', 'from-entity', 'manual', 'test:rel-check:from')
    RETURNING id
  `;
  const [toEntity] = await sql`
    INSERT INTO entities (domain, entity_type, name, source_system, source_ref)
    VALUES ('Code', 'Repository', 'to-entity', 'manual', 'test:rel-check:to')
    RETURNING id
  `;

  let error: any;
  try {
    await sql`
      INSERT INTO relationships (from_entity_id, to_entity_id, relationship_type)
      VALUES (${fromEntity.id}, ${toEntity.id}, 'NOT_A_REAL_TYPE')
    `;
  } catch (e) {
    error = e;
  }

  expect(error).toBeDefined();
  expect(error.errno).toBe("23514"); // check_violation
});
