// bunfig.toml [test] preload target. Runs the migration runner against
// DATABASE_URL (loaded by Bun from .env.test) before any test file executes,
// so every `bun test` run starts against an up-to-date schema.
// runMigrations() only applies migrations not yet recorded in
// schema_migrations, so this is safe (idempotent) to run on every test boot.
import { runMigrations } from "../scripts/migrate";

await runMigrations();
