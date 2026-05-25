-- Store the body of the most recent outbound reply per conversation.
-- last_outbound_at was added in 026 but only the timestamp — we needed
-- the body too so the dashboard preview line can show whichever side
-- spoke last (customer's "وينكم" if they messaged last, or staff's
-- "أرسلت لك العرض" if staff replied last).
--
-- Capped at 500 chars at the application layer to keep this column
-- small — the full message body still lives on Twilio.

alter table whatsapp_sessions
  add column if not exists last_outbound_body text;
