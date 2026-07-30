-- Third competition type: T-Rex runner (game of skill). Additive constraint
-- change only — the promised "no schema migration" path for new types.
alter table competitions drop constraint competitions_type_check;
alter table competitions add constraint competitions_type_check
  check (type in ('wonderlic', 'random_order', 'trex'));
