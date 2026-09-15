-- WhatsApp Bridge (Baileys) integration for the tourism assistant dashboard
-- Local bridge process talks to Supabase via the wa-bridge edge function (token-gated).
-- Dashboard (team.html) enqueues sends + reads groups/status via the same function (anon key).

-- Groups the bridge account is a member of (synced by the bridge)
create table if not exists public.wa_bridge_groups (
  jid         text primary key,
  name        text,
  size        int,
  updated_at  timestamptz not null default now()
);

-- Outbound message queue: dashboard inserts, bridge sends
create table if not exists public.wa_bridge_outbox (
  id          bigint generated always as identity primary key,
  target_jid  text not null,            -- e.g. 12345@g.us (group) or 9665...@s.whatsapp.net (number)
  target_name text,                     -- human label for display
  kind        text not null default 'text',  -- program | news | offer | text
  body        text not null,
  status      text not null default 'pending', -- pending | processing | sent | failed
  error       text,
  created_by  text,                     -- staff identifier from the dashboard
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists wa_bridge_outbox_status_idx on public.wa_bridge_outbox (status, created_at);

-- Saved ready-made offers (the "عروض جاهزة" library for quick sending)
create table if not exists public.wa_bridge_offers (
  id          bigint generated always as identity primary key,
  title       text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Singleton connection status / heartbeat
create table if not exists public.wa_bridge_status (
  id             int primary key default 1,
  online         boolean not null default false,
  account        text,
  groups_count   int,
  last_heartbeat timestamptz,
  constraint wa_bridge_status_singleton check (id = 1)
);
insert into public.wa_bridge_status (id, online) values (1, false)
  on conflict (id) do nothing;

-- RLS: lock everything. All access goes through the wa-bridge edge function,
-- which uses the service role (bypasses RLS). No direct anon table access.
alter table public.wa_bridge_groups  enable row level security;
alter table public.wa_bridge_outbox  enable row level security;
alter table public.wa_bridge_offers  enable row level security;
alter table public.wa_bridge_status  enable row level security;
