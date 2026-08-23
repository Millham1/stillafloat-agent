-- 0027 — what visitors actually CHOOSE in the Room Concierge.
--
-- Mark, 2026-08-18: "we should be capturing what the users are choosing and
-- learning from that to make better recommendations."
--
-- Until this table there was no learning anywhere in the concierge, and nothing
-- to build it from. cabin_advice is pre-written wording; the live reasoning is a
-- stateless per-search call with no memory of any previous visitor; and ranking
-- reads the fact layer only — the ship's own geometry, the researched zones, the
-- visitor's stated answers. Not one input came from what any visitor had ever
-- done. The picks themselves lived in a single browser-tab variable
-- (`this.picked = new Set()`) and died when the tab closed. The ONLY picks that
-- ever reached us were from the fraction who clicked "Send my picks", because
-- that URL carries the cabin numbers to the lead form. Everyone else told us
-- exactly what they wanted and we never heard it.
--
-- THIS IS STEP 1 OF THREE AND DELIBERATELY ONLY STEP 1 (Mark, 2026-08-23):
-- capture now, decide about learning later, once there is data to decide from.
-- Nothing here feeds ranking. Nothing here changes what a visitor sees.
--
-- WHAT MAKES A ROW USEFUL: not that a cabin was picked, but that it was picked
-- INSTEAD OF the others shown beside it. `shown` is therefore the whole choice
-- set and `picked` the chosen subset — a pick with no record of what it beat
-- teaches nothing. Same reason `suggested_ships` is kept next to `ship_slug`.
--
-- THE ROOM DATA STAYS PURE FACT (Mark's architecture rule). Preference is an
-- opinion about rooms and lives here, in its own table, never written back onto
-- `cabins`. The moment behaviour contaminates the fact layer you can no longer
-- tell what was measured from what was inferred.
--
-- PRIVACY — THIS IDENTIFIES NOBODY, BY CONSTRUCTION. No name, no email, no IP,
-- no user-agent, no cookie. `session_id` is minted fresh in the browser on each
-- page load and is never persisted client-side, so it cannot join one visit to
-- the next, or to a person. It exists only so the several updates of ONE visit
-- land on ONE row instead of piling up as duplicates. A visitor who then chooses
-- to identify themselves does so in the lead form, which is a separate table and
-- a separate, deliberate act by them.
--
-- Apply to DEV first; prod only after Mark's sign-off.

CREATE TABLE IF NOT EXISTS public.concierge_sessions (
  session_id      uuid PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  lang            text CHECK (lang IN ('en','es')),
  -- The two entry forks the landing screen offers, named exactly as the page
  -- names them so a value never has to be translated to be read:
  --   'ship'     = they named their ship and we only had to place them in it
  --   'discover' = they asked us to choose the ship too, so suggested_ships matters
  -- A 'ship' visitor can switch to 'discover' mid-flow ("show me what you'd pick
  -- for me"), and the row then records where they ENDED, which is the honest answer.
  path            text CHECK (path IN ('ship','discover')),

  -- What they told us: the normalised answer set only (party, room type, priority,
  -- budget, destination, motion + the derived personality axes). Whitelisted field
  -- by field in the route — never the raw request body, so no free text and no
  -- surprise field can ever arrive here.
  answers         jsonb,

  -- The ships we put in front of them, and the one they went into. Together these
  -- answer "does our ship suggestion match the ship they actually want?".
  suggested_ships text[],
  ship_slug       text,

  -- THE CHOICE SET: every cabin shown, in the order shown, with the few facts the
  -- card displayed. Rank is kept because "picked the 1st" and "picked the 9th"
  -- are different verdicts on our ordering.
  shown           jsonb,
  -- THE CHOSEN SUBSET: cabin numbers ticked as of the last update of this visit.
  picked          text[],
  -- Which beacon that pick list came from. The client counts its own beacons up
  -- from 1, and an older count can never overwrite a newer one. Without this the
  -- most important column in the table is decided by whichever write happens to
  -- reach Postgres first — measured going wrong on the very first sequential run,
  -- where a two-cabin list landed after the one-cabin list that replaced it.
  picked_seq      integer NOT NULL DEFAULT 0,

  -- Did our top picks satisfy them, or did they go looking for the full list?
  -- A high rate here is a verdict on the first screen, not on the ship.
  more_opened     boolean NOT NULL DEFAULT false,
  -- Did they click through to the lead form with picks in hand? The one place
  -- this table touches the funnel — as a boolean, never by storing who they are.
  sent            boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.concierge_sessions IS
  'One row per Room Concierge visit that reached room-level picks: what we showed, what they chose instead, and whether it converted. Capture only — nothing here feeds ranking yet (task 13a1f629 step 1). Anonymous by construction: no name, email, IP or cross-visit identifier.';
COMMENT ON COLUMN public.concierge_sessions.shown IS
  'The full choice set as displayed: [{cabin, deck, category, view, rank}]. Without it a pick is unreadable — you cannot tell what it was chosen over.';
COMMENT ON COLUMN public.concierge_sessions.picked IS
  'Cabin numbers ticked as of the last update. A preference signal, never an outcome: it records what someone chose, not whether they enjoyed the cruise.';
COMMENT ON COLUMN public.concierge_sessions.session_id IS
  'Client-minted per page load and never stored in the browser. Groups the updates of one visit; deliberately cannot link two visits or identify a person.';
COMMENT ON COLUMN public.concierge_sessions.more_opened IS
  'True if the visitor opened the full shortlist — a signal that the top five missed.';

CREATE INDEX IF NOT EXISTS concierge_sessions_ship_idx    ON public.concierge_sessions (ship_slug);
CREATE INDEX IF NOT EXISTS concierge_sessions_created_idx ON public.concierge_sessions (created_at DESC);
-- The question this table exists to answer is asked of converted sessions first.
CREATE INDEX IF NOT EXISTS concierge_sessions_sent_idx    ON public.concierge_sessions (sent) WHERE sent;

-- Service-role only, exactly like cabins/cabin_ships/cabin_advice. The page can
-- never read this back — it writes through /api/cabins/session and nothing else.
-- No anon policy: a public read path would turn an anonymous preference log into
-- a browsable one, and there is no reason for the browser to ever read it.
ALTER TABLE public.concierge_sessions ENABLE ROW LEVEL SECURITY;

-- ── The merge, done atomically in one statement ──────────────────────────────
--
-- WHY THIS IS A FUNCTION AND NOT AN UPSERT IN THE ROUTE. One visit writes
-- several times, and those writes RACE: the handler answers immediately (capture
-- must never make a visitor wait), so the browser fires its next beacon while the
-- previous one is still in flight, and the page itself never awaits any of them.
--
-- Merging in JavaScript — read the row, decide, write it back — loses that race
-- and was measured losing it: in the first end-to-end run six sequential beacons
-- produced a row with `path` null and a converted session recorded as sent=false,
-- because each handler read a row the others had not written yet.
--
-- So the merge happens where it can be atomic. ON CONFLICT takes the row lock,
-- and concurrent callers queue behind it instead of overwriting each other:
--   • COALESCE(excluded.x, c.x) — a beacon that omits a field leaves it alone,
--     so partial beacons are safe in any order.
--   • OR for the two flags — monotonic by construction now, not by hoping the
--     read happened after the write. A session that converted stays converted
--     however late or out-of-order the last beacon arrives.
--   • picked_seq gates `picked` — the newest snapshot of the ticks wins, and an
--     out-of-order beacon carrying an older one is ignored instead of resurrecting
--     a stale list. Plain last-write-wins was tried first and measured losing.
CREATE OR REPLACE FUNCTION public.concierge_capture(
  p_session   uuid,
  p_lang      text    DEFAULT NULL,
  p_path      text    DEFAULT NULL,
  p_answers   jsonb   DEFAULT NULL,
  p_suggested text[]  DEFAULT NULL,
  p_ship      text    DEFAULT NULL,
  p_shown     jsonb   DEFAULT NULL,
  p_picked    text[]  DEFAULT NULL,
  p_seq       integer DEFAULT 0,
  p_more      boolean DEFAULT false,
  p_sent      boolean DEFAULT false
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO public.concierge_sessions AS c
    (session_id, lang, path, answers, suggested_ships, ship_slug, shown, picked,
     picked_seq, more_opened, sent, updated_at)
  VALUES
    (p_session, p_lang, p_path, p_answers, p_suggested, p_ship, p_shown, p_picked,
     -- Only a beacon that CARRIES picks may set the gate. A beacon without them
     -- that happens to win the insert race must leave it at 0, or every real pick
     -- beacon behind it is rejected as stale and the visit records no picks at
     -- all — measured happening on exactly that ordering.
     CASE WHEN p_picked IS NOT NULL THEN COALESCE(p_seq, 0) ELSE 0 END,
     COALESCE(p_more, false), COALESCE(p_sent, false), now())
  ON CONFLICT (session_id) DO UPDATE SET
    lang            = COALESCE(excluded.lang,            c.lang),
    path            = COALESCE(excluded.path,            c.path),
    answers         = COALESCE(excluded.answers,         c.answers),
    suggested_ships = COALESCE(excluded.suggested_ships, c.suggested_ships),
    ship_slug       = COALESCE(excluded.ship_slug,       c.ship_slug),
    shown           = COALESCE(excluded.shown,           c.shown),
    -- Newest snapshot wins, and ONLY the newest: a late beacon carrying an older
    -- count is ignored rather than allowed to resurrect a stale list.
    picked          = CASE WHEN excluded.picked IS NOT NULL
                            AND excluded.picked_seq >= c.picked_seq
                           THEN excluded.picked ELSE c.picked END,
    -- Advances with `picked` and only with it, for the same reason.
    picked_seq      = CASE WHEN excluded.picked IS NOT NULL
                            AND excluded.picked_seq >= c.picked_seq
                           THEN excluded.picked_seq ELSE c.picked_seq END,
    more_opened     = c.more_opened OR excluded.more_opened,
    sent            = c.sent        OR excluded.sent,
    updated_at      = now();
$$;

COMMENT ON FUNCTION public.concierge_capture IS
  'Atomic merge for one Room Concierge visit. Absent fields are left alone; more_opened/sent only ever go false->true. Exists because the capture beacons race by design — see the note above it.';

-- The function runs as its caller. The backend calls it with the service role;
-- nothing else can reach it, because anon has no rights on the table it writes.
REVOKE ALL ON FUNCTION public.concierge_capture(uuid,text,text,jsonb,text[],text,jsonb,text[],integer,boolean,boolean) FROM public, anon, authenticated;
