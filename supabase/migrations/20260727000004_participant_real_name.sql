-- Members enter a display name for the board plus their actual name so the
-- commissioner knows who "Big Mike" is.
alter table participants add column real_name text;
