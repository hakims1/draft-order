-- App-level config: which admin accounts can see the business metrics dashboard.
insert into app_config (key, value) values ('app', '{
  "owner_emails": ["matt.hakims@gmail.com", "team@backgammon-cash.com"]
}'::jsonb);
