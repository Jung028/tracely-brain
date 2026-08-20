import { sql } from "bun";

/**
 * Truncates all row data used in tests. Never touches `schema_migrations` —
 * that table tracks which migrations have been applied and must survive
 * across test runs within a single schema lifetime.
 */
export async function truncateAll(): Promise<void> {
  await sql`TRUNCATE TABLE relationship_provenance, relationships, entities RESTART IDENTITY CASCADE`;
}
