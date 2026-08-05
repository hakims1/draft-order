-- Draft-order-is-in email to the commissioner.
--
-- The send is claimed with a conditional UPDATE on this column, so the many
-- concurrent requests that can observe "the competition just completed" (the
-- last member's submit, every other member's poll, the admin's dashboard)
-- race safely and exactly one of them sends.

alter table competitions
  add column if not exists completed_notified_at timestamptz;

-- Competitions that already finished before this feature existed must not
-- suddenly email their commissioners about a draft they ran days ago.
update competitions c set completed_notified_at = now()
where completed_notified_at is null
  and (
    c.status = 'closed'
    or (select count(*) from participants p
        where p.competition_id = c.id and not p.is_placeholder
          and (select count(distinct a.event_key) from attempts a
               where a.participant_id = p.id and a.status = 'finished')
              >= (case when c.type = 'combine' then 2 else 1 end)
       ) >= c.member_count
  );
