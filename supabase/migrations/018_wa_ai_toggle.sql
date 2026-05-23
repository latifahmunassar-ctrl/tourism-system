-- Global + per-conversation AI master switches for the WhatsApp router.
-- Admin can disable the AI globally (no auto-replies on ANY conversation)
-- or override per-conversation. The per-conversation flag takes priority:
--   ai_enabled=true  → AI replies even if global is off
--   ai_enabled=false → AI silent even if global is on
--   ai_enabled=null  → follow the global setting

-- Global key-value settings (single-row use case here).
create table if not exists wa_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Seed: AI on by default.
insert into wa_settings (key, value)
values ('ai_global_enabled', 'true'::jsonb)
on conflict (key) do nothing;

-- Per-conversation override.
alter table whatsapp_sessions
  add column if not exists ai_enabled boolean;
