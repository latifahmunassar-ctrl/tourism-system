-- ══════════════════════════════════════════════
-- Hourly cron: sync-sheets → chat_answers / hotels / tours / flights
-- ══════════════════════════════════════════════
--
-- Runs every hour on the hour. Calls the sync-sheets Edge Function via
-- pg_net so pickup is asynchronous (doesn't block Postgres).
--
-- The Authorization header carries the project's *legacy anon JWT*. This
-- key is public-by-design — it's already embedded in the frontend HTML
-- (latifahmunassar-ctrl.github.io/tourism-system/) and is the same key any
-- web client uses to call our Edge Functions. So checking it in here
-- doesn't leak anything new.
--
-- To change schedule:
--     SELECT cron.alter_job(jobid, schedule := '*/30 * * * *')
--     FROM cron.job WHERE jobname = 'sync-sheets-hourly';

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Re-runnable: drop any prior version first.
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'sync-sheets-hourly';
EXCEPTION WHEN OTHERS THEN
  NULL;
END$$;

SELECT cron.schedule(
  'sync-sheets-hourly',
  '0 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ofotvacszlmrqxzfjmtn.supabase.co/functions/v1/sync-sheets',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mb3R2YWNzemxtcnF4emZqbXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2MjI5NTYsImV4cCI6MjA5MzE5ODk1Nn0.1nQmxW63BFZSK-cn4fzh8tYM7a2JO10AQ0RGQ5bcdYo',
      'apikey',                  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mb3R2YWNzemxtcnF4emZqbXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2MjI5NTYsImV4cCI6MjA5MzE5ODk1Nn0.1nQmxW63BFZSK-cn4fzh8tYM7a2JO10AQ0RGQ5bcdYo',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);

