-- 0057: the two roads after "Save my spot!" (Mark 2026-10-24, Road A "Talk me into it, Mark!" and Road B "I've got this… let me fill it in!").
--
--   * group_interests.call_when  Road A: when the guest said Mark can catch them: morning, afternoon, evening or anytime. The drop-down on the group
--     page sets it together with choice = 'call'; the dashboard's "Ring ..." item and the replies table read it. Empty until they pick a time.
--   * group_interests.address    Road B: the one home address for the cabin that the guest typed (and the post office's spelling of it, when the lookup
--     tidied it) on their details page: {street, city, state, zip, tidied}. Kept on the reply until Mark adds the travelers to a cabin; "Add the travelers
--     to a cabin" then writes it, as one line, on the lead traveler's file (group_travelers.form_data.address, where the paperwork already reads it), so
--     group_travelers needs no new column.
--
-- ADDITIVE AND IDEMPOTENT: two new nullable columns and one check constraint, each guarded so that running this twice is harmless; no row changes, no
-- default, no rewrite. The code that reads them needs this applied FIRST (a select that names a missing column fails): apply it to dev and prod before
-- the branch that uses it is deployed. (The migration is written here and NOT applied: Mark applies migrations himself.)
alter table public.group_interests
  add column if not exists call_when text,
  add column if not exists address jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'group_interests_call_when_check' and conrelid = 'public.group_interests'::regclass) then
    alter table public.group_interests add constraint group_interests_call_when_check check (call_when is null or call_when in ('morning', 'afternoon', 'evening', 'anytime'));
  end if;
end $$;

comment on column public.group_interests.call_when is 'Road A: when the guest said Mark can ring them (morning | afternoon | evening | anytime), picked in the drop-down under "Talk me into it, Mark!" on the group page. Set together with choice = ''call''. Empty until they pick.';
comment on column public.group_interests.address is 'Road B: the guest''s one home address for the cabin, as typed on the details page: {street, city, state, zip, tidied}. tidied = true when the post office''s lookup corrected it and the guest accepted the correction. Copied, as one line, onto the lead traveler''s form_data.address when Mark adds the travelers to a cabin.';
