import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

/**
 * Keeps the two database setup paths in lockstep:
 * - fresh install: supabase/schema.sql (must also be safe to re-run);
 * - existing install: supabase/migrations/*.sql applied in order (each safe
 *   to re-run) on top of the schema as first published.
 * Both must produce the same columns, indexes, policies, constraints,
 * functions and triggers. Runs against PGlite (real Postgres in WASM +
 * pgvector), with small stubs for the Supabase-provided schemas.
 */

const ROOT = path.resolve(__dirname, '..');
// schema.sql exactly as first published (public release, 2026-04-02) — the
// oldest database any install can have. Kept as a fixture so the test needs
// no git history (the public and private repos don't share commits).
const FIRST_RELEASE_SCHEMA = path.join(__dirname, 'fixtures/schema-at-first-release.sql');

const SUPABASE_STUBS = `
create schema if not exists extensions;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean);
create table if not exists storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create schema if not exists auth;
create or replace function auth.role() returns text language sql as $$ select 'authenticated' $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
set search_path = public, extensions;
`;

const schemaSql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
const migrationDir = path.join(ROOT, 'supabase/migrations');
const migrations = fs.readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ name: f, sql: fs.readFileSync(path.join(migrationDir, f), 'utf8') }));

async function database() {
    const db = new PGlite({ extensions: { vector } });
    await db.exec(SUPABASE_STUBS);
    return db;
}

async function describe(db: PGlite) {
    const rows = async (sql: string) =>
        (await db.query<Record<string, unknown>>(sql)).rows.map((r) => Object.values(r).join(' | '));
    return {
        columns: await rows(`select table_name, column_name, data_type, is_nullable, coalesce(column_default, '')
            from information_schema.columns where table_schema = 'public' order by 1, 2`),
        indexes: await rows(`select tablename, indexname, regexp_replace(indexdef, 'CREATE (UNIQUE )?INDEX \\S+', '')
            from pg_indexes where schemaname = 'public' order by 1, 2`),
        policies: await rows(`select schemaname, tablename, policyname, cmd from pg_policies order by 1, 2, 3`),
        checks: await rows(`select conrelid::regclass::text, pg_get_constraintdef(oid) from pg_constraint
            where contype = 'c' and connamespace = 'public'::regnamespace order by 1, 2`),
        functions: await rows(`select proname, pg_get_function_arguments(oid), coalesce(array_to_string(proconfig, ','), '')
            from pg_proc where pronamespace = 'public'::regnamespace order by 1`),
        triggers: await rows(`select tgname from pg_trigger where not tgisinternal order by 1`),
    };
}

test('schema.sql is re-runnable, and upgrading via migrations matches a fresh install', { timeout: 120_000 }, async () => {
    const fresh = await database();
    await fresh.exec(schemaSql);
    await fresh.exec(schemaSql); // re-run must not fail
    // Captured before any migration runs: a migration must not be able to
    // paper over something missing from schema.sql
    const current = await describe(fresh);

    // Migrations must apply cleanly to a current schema and change nothing
    for (const m of migrations) await fresh.exec(m.sql);
    const afterMigrations = await describe(fresh);
    for (const key of Object.keys(current) as (keyof typeof current)[]) {
        assert.deepEqual(afterMigrations[key], current[key], `a migration changed ${key} on a fresh install — schema.sql is missing it`);
    }

    const upgraded = await database();
    await upgraded.exec(fs.readFileSync(FIRST_RELEASE_SCHEMA, 'utf8'));
    for (const m of migrations) await upgraded.exec(m.sql);
    for (const m of migrations) await upgraded.exec(m.sql); // each migration must be safe to re-run

    const upgradedShape = await describe(upgraded);
    for (const key of Object.keys(current) as (keyof typeof current)[]) {
        assert.deepEqual(upgradedShape[key], current[key], `${key} differ between a fresh install and an upgraded one`);
    }
});
