-- 0054: what a travel price is per (Mark 2026-10-20: "hotel prices are PER ROOM").
-- group_travel.price_per_person held every price as if it were per person; a hotel night is priced per room
-- (two guests share it), so a client read "Hotel ... $125 per person" and the number was wrong by half.
--   price_unit  'person' (default: a flight, a transfer) or 'room' (a hotel night)
-- The existing hotel rows are backfilled to 'room' ONCE, in the same step that adds the column, so running this
-- file a second time never flips a hotel row Mark has since set back to 'person'.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'group_travel' and column_name = 'price_unit'
  ) then
    alter table public.group_travel
      add column price_unit text not null default 'person'
      check (price_unit in ('person', 'room'));
    update public.group_travel set price_unit = 'room' where kind = 'hotel';
  end if;
end
$$;

comment on column public.group_travel.price_unit is 'What price_per_person is per: person (flight, transfer) or room (hotel). Shown to guests as "per person" / "per room".';
