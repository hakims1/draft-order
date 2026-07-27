-- Free-tier projects pause after ~7 days of inactivity. Self-ping the app's
-- health endpoint (which also touches the DB) every 6 hours to stay warm.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'keepalive-self-ping',
  '0 */6 * * *',
  $$ select net.http_get('https://bwxsuybqhgocmwncxzlz.supabase.co/functions/v1/draftday/health') $$
);
