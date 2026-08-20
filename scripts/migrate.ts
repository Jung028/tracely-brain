import { sql } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/**
 * Ensures `schema_migrations` exists, then applies any `.sql` files in
 * `migrations/` (in lexical order) that are not yet recorded in
 * `schema_migrations`. Each migration runs inside its own transaction and
 * is recorded (by filename, minus extension) on success. Idempotent — safe
 * to call on every test boot or app startup.
 */
export async function runMigrations(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const appliedRows = await sql`SELECT id FROM schema_migrations`;
  const applied = new Set(appliedRows.map((row: { id: string }) => row.id));

  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, "");
    if (applied.has(migrationId)) continue;

    const fileText = await Bun.file(join(MIGRATIONS_DIR, file)).text();

    await sql.begin(async (tx) => {
      await tx.unsafe(fileText);
      await tx`INSERT INTO schema_migrations (id) VALUES (${migrationId})`;
    });
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log("Migrations applied.");
}
