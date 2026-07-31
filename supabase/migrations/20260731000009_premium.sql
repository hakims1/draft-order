-- Premium tier: per-seat entitlements, multi-event attempts (the Combine),
-- and answer-key explanations.

-- 1. Entitlements v2 — per-seat capable. The old table was account-level only
--    and holds no rows (no purchases exist), so recreate with the new shape.
drop table entitlements;
create table entitlements (
  id uuid primary key default gen_random_uuid(),
  sku text not null check (sku in ('ultimate', 'answer_key')),
  admin_id uuid references admins(id) on delete cascade,
  competition_id uuid references competitions(id) on delete cascade,
  granted_to_participant_id uuid references participants(id) on delete cascade,
  granted_at timestamptz not null default now(),
  source text not null default 'mock'
);
-- idempotency: one ultimate per account, one answer key per seat
create unique index entitlements_ultimate_uq on entitlements (admin_id, sku)
  where sku = 'ultimate';
create unique index entitlements_seat_uq on entitlements (granted_to_participant_id, sku)
  where sku = 'answer_key';

-- 2. attempts.event_key — one attempt per participant per event, so the
--    Combine can hold a test attempt and a runner attempt side by side.
alter table attempts add column event_key text;
update attempts a set event_key = c.type
from participants p, competitions c
where a.participant_id = p.id and p.competition_id = c.id;
alter table attempts alter column event_key set not null;
alter table attempts drop constraint attempts_participant_id_attempt_number_key;
alter table attempts add constraint attempts_participant_event_attempt_uq
  unique (participant_id, event_key, attempt_number);

-- 3. The Combine competition type.
alter table competitions drop constraint competitions_type_check;
alter table competitions add constraint competitions_type_check
  check (type in ('wonderlic', 'random_order', 'trex', 'combine'));

-- 4. One-line explanations for the answer key.
alter table questions add column explanation text;
update questions q set explanation = v.e
from (values
  (1,  'A sock covers a foot the way a glove covers a hand.'),
  (2,  'Abundant means existing in large quantities — plentiful.'),
  (3,  'To expand is to grow; to contract is to shrink.'),
  (4,  'The series climbs by 3 each step.'),
  (5,  '4 × 25 cents = 100 cents = $1.00.'),
  (6,  'Half of a dozen (12) is 6.'),
  (7,  'If all dogs bark and Rex is a dog, barking follows necessarily.'),
  (8,  'Concentrating everything in one place risks losing it all at once.'),
  (9,  'Two days after Wednesday: Thursday, then Friday.'),
  (10, 'A hexagon has 6 sides — more than a triangle, square, or pentagon.'),
  (11, 'A sculptor produces a statue the way an author produces a novel.'),
  (12, 'Reckless means careless of danger; cautious is its opposite.'),
  (13, 'The gaps grow by one each time: +1, +2, +3, +4, then +5.'),
  (14, 'The series falls by 6 each step.'),
  (15, '25% of $40 is $10, so the sale price is $30.'),
  (16, '120 miles ÷ 2 hours = 60 mph.'),
  (17, 'Rain guarantees a cancellation, so no cancellation means no rain.'),
  (18, 'A small fix now prevents a bigger repair later.'),
  (19, 'The pattern is every other letter of the alphabet.'),
  (20, 'March 15 is exactly two weeks after March 1 — same weekday.'),
  (21, 'The pronoun "he" could refer to either the coach or the player.'),
  (22, 'It can mean piloting planes, or planes that are flying.'),
  (23, 'A drought is a shortage of rain; a famine is a shortage of food.'),
  (24, 'Frugal means careful with money; wasteful is its opposite — thrifty is a synonym.'),
  (25, 'The gap doubles each step: +1, +2, +4, +8, then +16.'),
  (26, 'Four games averaging 27 needs 108 total; 108 − 75 scored so far = 33.'),
  (27, 'All Larks sit inside Mubs, and no Mub is a Tock, so no Lark can be one.'),
  (28, 'A calm surface can hide depth — and so can quiet people.'),
  (29, 'A cube has 4 top edges, 4 bottom edges, and 4 vertical edges.'),
  (30, '95 minutes is 1h 35m; 11:40 plus 1:35 is 1:15 PM.')
) as v(pos, e)
where q.bank_version = 1 and q.position = v.pos;
