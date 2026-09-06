-- 0030: public Storage bucket for Instagram Reel clips (2026-09-06).
-- Instagram's publishing API fetches media from a public URL; Mark chose to host
-- clips on our own Supabase rather than Cloudinary. Objects are written only via
-- signed upload URLs minted by the backend (service role); reads are public by URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-clips', 'social-clips', true, 209715200, array['video/mp4'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
