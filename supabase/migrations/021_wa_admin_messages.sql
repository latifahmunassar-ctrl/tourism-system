-- Tracks messages sent to customers FROM the admin dashboard so the
-- conversation timeline can label them "Admin" instead of "AI". The
-- Twilio API gives us every outbound message; this table tells us which
-- of those originated from a human admin via the dashboard.
--
-- Twilio SID is the join key. Body is stored as a backup fallback (in
-- case the SID isn't captured — e.g., Twilio response wasn't parsed).

create table if not exists wa_admin_messages (
  id uuid primary key default gen_random_uuid(),
  twilio_sid text,
  customer_phone text not null,
  body text,
  sent_by text not null default 'admin',   -- 'admin' | 'staff'
  sent_at timestamptz not null default now()
);
create index if not exists wa_admin_messages_phone_idx
  on wa_admin_messages (customer_phone, sent_at desc);
create index if not exists wa_admin_messages_sid_idx
  on wa_admin_messages (twilio_sid);
