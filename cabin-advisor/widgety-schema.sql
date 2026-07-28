-- widgety-schema.sql — ISOLATED capture store for the Widgety booking feed.
-- Deliberately NOT in supabase/migrations/ so it does NOT auto-deploy to prod.
-- Lives in its own `widgety` schema, kept out of the working `public` tables
-- (Mark, 2026-07-27: "keep the data separate so we don't pollute the working DBs;
-- merge later if I decide to continue and the process pans out").
--
-- Applied to the DEV Supabase (vmbysqjvwfzmsrwgubib) only, via apply_migration.
-- Populated by cabin-advisor/widgety-harvest.mjs.
-- To MERGE later: `ALTER TABLE widgety.<t> SET SCHEMA public;` (+ rename).
-- To DROP:        `DROP SCHEMA widgety CASCADE;`
--
-- NOTE: writing via supabase-js/PostgREST required exposing the schema on dev:
--   ALTER ROLE authenticator SET pgrst.db_schemas TO 'public, graphql_public, widgety';
--   NOTIFY pgrst, 'reload config';  NOTIFY pgrst, 'reload schema';
-- Reverse with: ALTER ROLE authenticator RESET pgrst.db_schemas; (+ reload).

CREATE SCHEMA IF NOT EXISTS widgety;
GRANT USAGE ON SCHEMA widgety TO anon, authenticated, service_role;

-- One row per ship. `raw` holds the FULL Widgety ship payload (durable static
-- content: descriptions, dining, entertainment, enrichment, cabin grades w/ sizes,
-- deckplans, image URLs) — that content doesn't go stale, so a single capture keeps.
CREATE TABLE IF NOT EXISTS widgety.ships (
  slug         text PRIMARY KEY,
  title        text,
  operator     text,
  ship_class   text,
  imo          text,
  size         text,
  style        text,
  ship_type    text,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  raw          jsonb
);

-- Indicative sample of upcoming sailings + headline "from" prices by cabin type.
-- VOLATILE (dates/prices change) — treat as a teaser, not a quote; the firm price
-- comes from Mark's own live agency booking access at conversion.
CREATE TABLE IF NOT EXISTS widgety.sailings (
  date_ref        text PRIMARY KEY,
  ship_slug       text,
  ship_title      text,
  operator        text,
  date_from       date,
  date_to         date,
  nights          integer,
  regions         text[],
  countries       text[],
  themes          text[],
  availability    text,
  headline_prices jsonb,
  captured_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS widgety_sailings_ship_idx ON widgety.sailings (ship_slug);
CREATE INDEX IF NOT EXISTS widgety_sailings_from_idx ON widgety.sailings (date_from);

ALTER TABLE widgety.ships    ENABLE ROW LEVEL SECURITY;  -- service-role only
ALTER TABLE widgety.sailings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON ALL TABLES IN SCHEMA widgety TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA widgety GRANT ALL ON TABLES TO service_role;
