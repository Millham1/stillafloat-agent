-- 0032: ideas.triage_category must admit 'port_tip'.
-- 2026-09-06 added the port_tip triage action (phone notes about a port file into
-- public.port_tips instead of the task list). The ideas row update that closes the
-- idea as triaged/port_tip violated ideas_triage_category_check, so every 15-minute
-- triage pass re-ran the two Bermuda notes and logged
-- "new row for relation ideas violates check constraint" (found 2026-09-09).
alter table public.ideas drop constraint if exists ideas_triage_category_check;
alter table public.ideas add constraint ideas_triage_category_check
  check (triage_category = any (array['existing_thread','new_task','content_idea','reference','port_tip']));
