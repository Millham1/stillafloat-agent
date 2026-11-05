-- 0072_group_quote_final.sql — Mark finalizes the quote before the guest can agree (Mark 2026-11-05: "the price they see is the unqualified price
-- and doesnt account for extras or upgrades, so they need to commit to the updated quote. that means it should come to me first").
--   group_interests.quote_requested_at  when the guest sent their choices to Mark: the answers are frozen and Mark's item says "Finalize the quote"
--   group_interests.quote_final_at      when Mark sent the final quote (his prices, extras and upgrades): only now can the guest agree
--   group_interests.quote_token_hash    sha256 of the link in the "your quote is ready" email (only hashes are kept, so the first link cannot be
--                                       re-sent; both links open the same page and share the first link's 90 days)
alter table public.group_interests
  add column if not exists quote_requested_at timestamptz,
  add column if not exists quote_final_at timestamptz,
  add column if not exists quote_token_hash text;
create index if not exists group_interests_quote_token_hash_idx on public.group_interests (quote_token_hash) where quote_token_hash is not null;
