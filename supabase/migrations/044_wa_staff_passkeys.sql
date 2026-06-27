-- مفاتيح المرور (Passkey / بصمة / Face ID) لموظفي داشبورد الواتساب (wa_staff).
-- منفصل عن user_passkeys الخاصة بـ app_users. الوصول عبر service role فقط (دالة webauthn).
create table if not exists public.wa_staff_passkeys (
  id uuid primary key default gen_random_uuid(),
  staff_phone text not null,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text,
  device_label text,
  device_token text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists wa_staff_passkeys_staff_phone_idx on public.wa_staff_passkeys (staff_phone);
alter table public.wa_staff_passkeys enable row level security;
comment on table public.wa_staff_passkeys is 'مفاتيح المرور (Passkey/بصمة) لموظفي داشبورد الواتساب (wa_staff) — مفصولة عن user_passkeys الخاصة بـ app_users. الوصول عبر service role فقط (دالة webauthn).';
