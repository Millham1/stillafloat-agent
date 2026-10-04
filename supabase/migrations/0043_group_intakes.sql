-- 0043: "Enter a booking" (Mark, 2026-10-02) — he drops the cruise line's
-- contract or quote PDF, the server reads it and pre-fills the group file.
-- One intake row per dropped document; the PDF itself lives in a PRIVATE
-- Storage bucket (contracts carry names and prices) and is filed on the group
-- as a document once Mark accepts the extraction.

alter table public.groups
  add column if not exists booking_kind text not null default 'group'
    check (booking_kind in ('group','individual')),
  add column if not exists source_intake_id uuid;

create table if not exists public.group_intakes (
  id uuid primary key default gen_random_uuid(),
  booking_kind text not null default 'group' check (booking_kind in ('group','individual')),
  lang text not null default 'en' check (lang in ('en','es','both')),
  filename text not null,
  storage_path text not null,            -- group-docs/<intake id>/<filename>
  bytes integer not null,
  status text not null default 'queued'
    check (status in ('queued','reading','extracting','ready','accepted','failed')),
  text_chars integer,                    -- how much text the PDF yielded (0 = scanned image, needs OCR)
  extracted jsonb,                       -- what the model read, normalised (see lib/booking-extract.ts)
  model text,                            -- which model answered (local box or Claude id)
  error text,
  group_id uuid references public.groups(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.group_intakes enable row level security;
comment on table public.group_intakes is 'Dropped contract/quote PDFs and what the reader extracted from them. Service role only.';

-- Private bucket: PDFs only, 20 MB cap. No public reads; the backend mints
-- signed URLs when Mark opens a filed document.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('group-docs', 'group-docs', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
