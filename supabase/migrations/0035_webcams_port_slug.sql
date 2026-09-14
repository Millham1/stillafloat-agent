-- 0035: which cruise port each webcam looks at, so the page can say which of
-- our tracked ships are in frame right now (Mark, 2026-09-14: cams pointed at
-- cruise terminals, each showing the ships in port). Beach cams keep NULL.
alter table public.webcams add column if not exists port_slug text;
update public.webcams set port_slug = case slug
  when 'portmiami' then 'miami'
  when 'key-west'  then 'key-west'
  when 'galveston' then 'galveston'
  when 'vancouver' then 'vancouver'
  when 'cozumel'   then 'cozumel'
end where port_slug is null;
