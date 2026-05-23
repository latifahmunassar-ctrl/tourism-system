-- Staff roster + auto-routing rules + per-session assignment.
--
-- Flow at runtime:
--   1. Every inbound message: try to extract a destination (via
--      DESTINATION_HINTS regex inside the function).
--   2. If session has no assigned_staff_phone yet AND destination matched
--      AND there's an active routing rule for that destination → set
--      session.assigned_staff_phone and ping the staff on WhatsApp.
--   3. Subsequent escalations for that customer get routed to the
--      assigned staff (instead of broadcasting to all SALES numbers).
--   4. Admin or staff can manually transfer via the dashboard.

create table if not exists wa_staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text unique not null,        -- whatsapp:+E.164
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists wa_routing_rules (
  id uuid primary key default gen_random_uuid(),
  match_destination text,            -- normalized canonical, e.g. "ماليزيا"
  assign_to_phone text not null,
  priority int not null default 0,   -- higher checked first
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists wa_routing_rules_active_idx
  on wa_routing_rules (active, priority desc);

alter table whatsapp_sessions
  add column if not exists assigned_staff_phone text,
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by text;       -- "auto" | staff phone who transferred
