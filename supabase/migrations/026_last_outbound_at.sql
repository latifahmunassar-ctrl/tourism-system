-- Track the most recent OUTBOUND reply per conversation so the
-- dashboard can highlight "unanswered" rows: any conversation where
-- the latest inbound message arrived AFTER the latest outbound reply
-- (or there's been no outbound at all) is flagged in the UI.
--
-- Populated by sendCustomerReply() — the wrapper around sendWhatsapp
-- that fires whenever the bot/admin/staff sends to the customer.

alter table whatsapp_sessions
  add column if not exists last_outbound_at timestamptz;

create index if not exists whatsapp_sessions_unanswered_idx
  on whatsapp_sessions (last_outbound_at);
