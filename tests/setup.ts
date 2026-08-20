// bunfig.toml [test] preload target. Runs the migration runner against
// DATABASE_URL (loaded by Bun from .env.test) before any test file executes,
// so every `bun test` run starts against an up-to-date schema.
// runMigrations() only applies migrations not yet recorded in
// schema_migrations, so this is safe (idempotent) to run on every test boot.
import { join } from "node:path";
import { runMigrations } from "../scripts/migrate";

// Force-load .env.test onto process.env, overriding whatever is already
// set. Bun auto-loads .env.test for `bun test`, but it does NOT override a
// variable that's already present in the environment — so a developer with
// a stale/invalid GITHUB_TOKEN exported in their shell silently shadows the
// real value from .env.test, and live-GitHub tests fail for a reason
// unrelated to whatever was just edited (see review Finding 5). Deleting
// process.env.GITHUB_TOKEN here wouldn't help: by the time this preload
// runs, Bun has already merged .env.test in without overriding the shadowed
// var, so the real value is gone from process.env — it has to be re-read
// from the file directly and force-assigned.
const ENV_TEST_PATH = join(import.meta.dir, "..", ".env.test");

async function loadEnvTestOverrides(): Promise<void> {
  const file = Bun.file(ENV_TEST_PATH);
  if (!(await file.exists())) {
    return;
  }

  const text = await file.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      process.env[key] = value;
    }
  }
}

await loadEnvTestOverrides();
await runMigrations();
