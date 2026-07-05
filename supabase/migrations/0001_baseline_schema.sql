-- 0001_baseline_schema.sql
-- Baseline snapshot of the PROD public schema (stillafloat-platform,
-- gbjfrnrkkjnutmogdzln) as of 2026-07-04, captured to make the dev Supabase
-- (stillafloat-dev, vmbysqjvwfzmsrwgubib) a true mirror. Apply to a FRESH db.
--
-- Migration convention (see README.md): numbered SQL files, applied DEV FIRST,
-- then PROD, and committed to the repo so dev/prod schema can never silently drift.
-- The app reads these tables via supabase-js (drizzle is unused). RLS is ON for
-- every table; the backend uses the service-role key to bypass it. Only the two
-- public write paths (contact form → prospects, phone notes → ideas) get an
-- anon INSERT policy.

-- ── Tables ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.calendar_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_title text,
  event_start timestamp with time zone,
  event_end timestamp with time zone,
  gcal_event_id text,
  action text NOT NULL,
  source_email_id text,
  detail jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ideas (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  note_text text NOT NULL,
  content_hash text NOT NULL,
  source text NOT NULL DEFAULT 'iphone_notes'::text,
  captured_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'new'::text,
  triage_category text,
  triage_notes text,
  related_to text,
  triaged_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.platform_state (
  id text NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.prospects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  preferred_lang text DEFAULT 'en'::text,
  num_travelers integer,
  travel_dates text,
  destination text,
  cruise_line_pref text,
  budget_range text,
  first_time boolean DEFAULT false,
  referral_source text,
  notes text,
  status text DEFAULT 'new'::text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ships (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  cruise_line text NOT NULL,
  regions text[] NOT NULL DEFAULT '{}'::text[],
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.storm_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  nhc_id text NOT NULL,
  basin text,
  name text,
  classification text,
  status text NOT NULL DEFAULT 'draft'::text,
  is_threat boolean NOT NULL DEFAULT false,
  affected_grounds text[] NOT NULL DEFAULT '{}'::text[],
  formation_chance integer,
  headline text,
  body_md text,
  raw jsonb,
  content_hash text,
  first_seen timestamp with time zone NOT NULL DEFAULT now(),
  last_updated timestamp with time zone NOT NULL DEFAULT now(),
  approved_at timestamp with time zone,
  sent_at timestamp with time zone,
  sent_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.subscribers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  token text,
  created_at timestamp with time zone DEFAULT now(),
  confirmed_at timestamp with time zone,
  lang text NOT NULL DEFAULT 'en'::text,
  alerts_opt_in boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  vendor text NOT NULL,
  description text,
  amount numeric(12,2),
  currency text NOT NULL DEFAULT 'USD'::text,
  cadence text NOT NULL DEFAULT 'monthly'::text,
  next_charge_date date,
  category text,
  payment_source text NOT NULL DEFAULT 'unknown'::text,
  status text NOT NULL DEFAULT 'active'::text,
  detected_from text NOT NULL DEFAULT 'manual'::text,
  last_seen date,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open'::text,
  priority integer NOT NULL DEFAULT 3,
  category text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  done_at timestamp with time zone,
  source_idea_id uuid
);

CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  direction text NOT NULL DEFAULT 'expense'::text,
  doc_type text NOT NULL DEFAULT 'receipt'::text,
  vendor text,
  description text,
  amount numeric(12,2),
  currency text NOT NULL DEFAULT 'USD'::text,
  txn_date date,
  due_date date,
  category text,
  payment_source text NOT NULL DEFAULT 'unknown'::text,
  reimbursable boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'captured'::text,
  source text NOT NULL DEFAULT 'email'::text,
  source_ref text,
  content_hash text,
  raw_extract jsonb,
  attachment_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- ── Primary keys / unique / foreign keys / checks ────────────────────────────
ALTER TABLE public.calendar_log ADD CONSTRAINT calendar_log_pkey PRIMARY KEY (id);
ALTER TABLE public.calendar_log ADD CONSTRAINT calendar_log_action_check CHECK ((action = ANY (ARRAY['added'::text, 'conflict_alerted'::text, 'resolved_keep_new'::text, 'resolved_keep_existing'::text, 'resolved_both'::text, 'reminder_sent'::text])));
ALTER TABLE public.ideas ADD CONSTRAINT ideas_pkey PRIMARY KEY (id);
ALTER TABLE public.ideas ADD CONSTRAINT ideas_content_hash_key UNIQUE (content_hash);
ALTER TABLE public.ideas ADD CONSTRAINT ideas_status_check CHECK ((status = ANY (ARRAY['new'::text, 'triaged'::text, 'actioned'::text, 'archived'::text])));
ALTER TABLE public.ideas ADD CONSTRAINT ideas_triage_category_check CHECK ((triage_category = ANY (ARRAY['existing_thread'::text, 'new_task'::text, 'content_idea'::text, 'reference'::text])));
ALTER TABLE public.platform_state ADD CONSTRAINT platform_state_pkey PRIMARY KEY (id);
ALTER TABLE public.prospects ADD CONSTRAINT prospects_pkey PRIMARY KEY (id);
ALTER TABLE public.ships ADD CONSTRAINT ships_pkey PRIMARY KEY (id);
ALTER TABLE public.storm_alerts ADD CONSTRAINT storm_alerts_pkey PRIMARY KEY (id);
ALTER TABLE public.subscribers ADD CONSTRAINT subscribers_pkey PRIMARY KEY (id);
ALTER TABLE public.subscribers ADD CONSTRAINT subscribers_email_key UNIQUE (email);
ALTER TABLE public.subscribers ADD CONSTRAINT subscribers_token_key UNIQUE (token);
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_cadence_check CHECK ((cadence = ANY (ARRAY['monthly'::text, 'annual'::text, 'quarterly'::text, 'weekly'::text, 'other'::text])));
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_payment_source_check CHECK ((payment_source = ANY (ARRAY['business'::text, 'personal'::text, 'unknown'::text])));
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text, 'paused'::text, 'trial'::text])));
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_detected_from_check CHECK ((detected_from = ANY (ARRAY['email'::text, 'manual'::text, 'connector_audit'::text])));
ALTER TABLE public.tasks ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);
ALTER TABLE public.tasks ADD CONSTRAINT tasks_source_idea_id_fkey FOREIGN KEY (source_idea_id) REFERENCES ideas(id) ON DELETE SET NULL;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'blocked'::text, 'done'::text, 'deferred'::text])));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.transactions ADD CONSTRAINT transactions_content_hash_key UNIQUE (content_hash);
ALTER TABLE public.transactions ADD CONSTRAINT transactions_direction_check CHECK ((direction = ANY (ARRAY['expense'::text, 'income'::text])));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_doc_type_check CHECK ((doc_type = ANY (ARRAY['receipt'::text, 'invoice'::text, 'subscription_charge'::text, 'other'::text])));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_payment_source_check CHECK ((payment_source = ANY (ARRAY['business'::text, 'personal'::text, 'unknown'::text])));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_source_check CHECK ((source = ANY (ARRAY['email'::text, 'telegram_photo'::text, 'ios_scan'::text, 'manual'::text])));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_status_check CHECK ((status = ANY (ARRAY['captured'::text, 'reviewed'::text, 'reconciled'::text, 'paid'::text, 'void'::text])));

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS calendar_log_created_at_idx ON public.calendar_log USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON public.ideas USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS ships_name_key ON public.ships USING btree (name);
CREATE INDEX IF NOT EXISTS storm_alerts_status_idx ON public.storm_alerts USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS storm_alerts_nhc_id_key ON public.storm_alerts USING btree (nhc_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON public.subscriptions USING btree (status);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON public.tasks USING btree (status);
CREATE INDEX IF NOT EXISTS idx_tasks_source_idea_id ON public.tasks USING btree (source_idea_id);
CREATE INDEX IF NOT EXISTS tasks_priority_idx ON public.tasks USING btree (priority);
CREATE INDEX IF NOT EXISTS transactions_status_idx ON public.transactions USING btree (status);
CREATE INDEX IF NOT EXISTS transactions_vendor_idx ON public.transactions USING btree (vendor);
CREATE INDEX IF NOT EXISTS transactions_txn_date_idx ON public.transactions USING btree (txn_date DESC);
CREATE INDEX IF NOT EXISTS transactions_category_idx ON public.transactions USING btree (category);

-- ── Row Level Security ───────────────────────────────────────────────────────
ALTER TABLE public.calendar_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ideas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospects      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ships          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storm_alerts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscribers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions   ENABLE ROW LEVEL SECURITY;

-- Public anon INSERT paths only (contact form + phone notes). No anon read/update/delete.
DROP POLICY IF EXISTS "anon can submit ideas" ON public.ideas;
CREATE POLICY "anon can submit ideas" ON public.ideas FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "anon can submit leads" ON public.prospects;
CREATE POLICY "anon can submit leads" ON public.prospects FOR INSERT TO anon WITH CHECK (true);
