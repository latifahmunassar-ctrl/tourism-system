-- Lightweight audit trail for every WhatsApp inbound the function processes.
-- Each Twilio webhook insert a row at status='received' before handleMessage
-- kicks off. handleMessage updates to 'completed' on success or 'errored' on
-- exception. The next incoming webhook also runs a watchdog: any row that
-- stayed at 'received' past a 30-second threshold gets flipped to 'stalled'
-- and a WhatsApp alert is sent to SALES_WHATSAPP_NUMBERS.
--
-- The point isn't to prevent intermittent failures — it's to make them
-- visible. If a customer message silently fails (function killed in
-- background after returning TwiML, etc.), the admin gets a 🔁 alert
-- instead of the customer just being ignored.

create table if not exists wa_message_audit (
  id uuid primary key default gen_random_uuid(),
  from_phone text not null,
  body text,
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'received',
  error_message text
);

create index if not exists wa_message_audit_status_idx
  on wa_message_audit (status, received_at);
create index if not exists wa_message_audit_from_idx
  on wa_message_audit (from_phone, received_at desc);
