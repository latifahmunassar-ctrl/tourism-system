-- Track when each conversation was last opened in the dashboard by any
-- staff/admin/monitor. Combined with last_inbound_at, lets the UI
-- highlight "unread" conversations:
--
--   unread  ↔  last_opened_at IS NULL
--         OR  last_opened_at < last_inbound_at
--
-- مكتمل = read. مكتمل ثم رسالة جديدة من العميل = unread مرة ثانية.

alter table whatsapp_sessions
  add column if not exists last_opened_at timestamptz;

create index if not exists whatsapp_sessions_last_opened_idx
  on whatsapp_sessions (last_opened_at);
