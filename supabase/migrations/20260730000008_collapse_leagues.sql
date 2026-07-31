-- Collapse the league/season/competition hierarchy: people create a
-- competition, run it, and leave. Competitions now own their name, size, and
-- admin directly; the leagues table and season_year are retired.
alter table competitions add column admin_id uuid references admins(id) on delete cascade;
alter table competitions add column name text;
alter table competitions add column member_count int;

update competitions c
set admin_id = l.admin_id, name = l.name, member_count = l.member_count
from leagues l where l.id = c.league_id;

alter table competitions alter column admin_id set not null;
alter table competitions alter column name set not null;
alter table competitions alter column member_count set not null;
alter table competitions add constraint competitions_member_count_check
  check (member_count between 2 and 64);

alter table competitions drop column league_id;
drop table leagues;
