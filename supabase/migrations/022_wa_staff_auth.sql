-- Staff username/password login + session bearer tokens.
--
-- Each row in wa_staff can be assigned a username + password_hash by the
-- admin (master legacy token endpoint). Staff log in with username +
-- password; verifying mints a session token that the dashboard stores
-- as Authorization: Bearer <token> for subsequent admin endpoints.

alter table wa_staff
  add column if not exists username text,
  add column if not exists password_hash text,           -- format: "salthex:hashhex" (PBKDF2-SHA256)
  add column if not exists password_set_at timestamptz;

-- Unique on username when present (multiple staff without usernames
-- shouldn't collide).
create unique index if not exists wa_staff_username_uidx
  on wa_staff (username) where username is not null;

-- Active staff dashboard sessions. Token is opaque 64-char hex.
-- 24-hour lifetime; revoked_at supports manual sign-out.
create table if not exists wa_staff_sessions (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  username text,
  token text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists wa_staff_sessions_token_idx
  on wa_staff_sessions (token);
create index if not exists wa_staff_sessions_phone_idx
  on wa_staff_sessions (phone, created_at desc);
