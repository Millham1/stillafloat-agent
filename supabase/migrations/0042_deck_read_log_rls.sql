-- 0042: deck_read_log was created without row level security (the only public
-- table without it — flagged by the Supabase advisor 2026-10-02, Mark: yes).
-- Service role bypasses RLS, so the deck-plan worklist tooling is unaffected.
alter table public.deck_read_log enable row level security;
