# Supabase migrations

Version-controlled schema for both Supabase projects:

- **prod** — `stillafloat-platform` (`gbjfrnrkkjnutmogdzln`)
- **dev**  — `stillafloat-dev` (`vmbysqjvwfzmsrwgubib`)

These tables are read by the app via **supabase-js** (drizzle is unused — its
schema is empty). This directory is the source of truth for their structure so
**dev and prod can never silently drift** (they did: dev was empty on 2026-07-04).

## Rules

1. Every schema change is a **new numbered SQL file** here (`NNNN_name.sql`), committed to the repo.
2. Apply it to **dev first**, verify, then to **prod** — never prod-first.
3. Never hand-create tables in one project only. If it isn't a committed migration, it doesn't exist.
4. RLS is ON for every table; the backend uses the service-role key. Add an anon policy only for a genuine public write path.

## Applying

Via the Supabase MCP (`apply_migration`) or the Supabase CLI, against dev first:

```
# dev
supabase db push --db-url "$DEV_DATABASE_URL"    # or apply_migration to vmbysqjvwfzmsrwgubib
# then prod, after sign-off
supabase db push --db-url "$PROD_DATABASE_URL"    # or apply_migration to gbjfrnrkkjnutmogdzln
```

## Files

- `0001_baseline_schema.sql` — snapshot of prod as of 2026-07-04 (10 tables + constraints + indexes + RLS). Baseline; apply once to a fresh DB.
