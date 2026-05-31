-- ══════════════════════════════════════════════
-- Minutely cron: watchdog for stalled inbound WhatsApp messages
-- ══════════════════════════════════════════════
--
-- يستدعي WhatsApp-Router?admin_action=run_watchdog كل دقيقة عبر pg_net،
-- فينبّه أرقام المبيعات بأي رسالة عميل لم يكتمل التعامل معها — حتى في
-- الأوقات الهادئة (الحارس داخل الـ webhook يعمل فقط عند وصول رسالة جديدة).
--
-- نفس مفتاح الـ legacy anon JWT المستخدم في 015 (عام بالتصميم، يطابق
-- LEGACY_ANON_JWT الذي يتحقق منه checkAuth).
--
-- لتغيير الجدولة:
--     SELECT cron.alter_job(jobid, schedule := '*/2 * * * *')
--     FROM cron.job WHERE jobname = 'whatsapp-watchdog-minutely';

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'whatsapp-watchdog-minutely';
EXCEPTION WHEN OTHERS THEN
  NULL;
END$$;

SELECT cron.schedule(
  'whatsapp-watchdog-minutely',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ofotvacszlmrqxzfjmtn.supabase.co/functions/v1/WhatsApp-Router?admin_action=run_watchdog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mb3R2YWNzemxtcnF4emZqbXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2MjI5NTYsImV4cCI6MjA5MzE5ODk1Nn0.1nQmxW63BFZSK-cn4fzh8tYM7a2JO10AQ0RGQ5bcdYo',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mb3R2YWNzemxtcnF4emZqbXRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2MjI5NTYsImV4cCI6MjA5MzE5ODk1Nn0.1nQmxW63BFZSK-cn4fzh8tYM7a2JO10AQ0RGQ5bcdYo',
      'Content-Type',  'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cron$
);
