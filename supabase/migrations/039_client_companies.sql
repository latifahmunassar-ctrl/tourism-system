-- 039_client_companies.sql
-- B2B company accounts: register → staff approval → company login → linked trip requests.
-- Companies register once (profile + logo + password). A staff member approves the
-- account and adds the WhatsApp group link. Approved companies log in by phone +
-- password and submit trip requests without re-entering their profile.

create table if not exists client_companies (
  id                  uuid primary key default gen_random_uuid(),
  company_name        text not null,
  contact_name        text,
  contact_phone       text not null unique,          -- login identifier
  contact_email       text,
  password_hash       text not null,                 -- sha-256(salt + password)
  password_salt       text not null,
  logo_url            text,                          -- public URL in company-logos bucket
  website             text,                          -- website or instagram url/handle
  whatsapp_group_link text,                          -- staff fills on approval
  status              text not null default 'pending', -- pending | approved | rejected | suspended
  notes               text,                          -- internal staff notes
  login_token         text,                          -- rotating session token issued on login
  created_at          timestamptz not null default now(),
  approved_at         timestamptz,
  approved_by         text
);

create index if not exists idx_client_companies_phone  on client_companies(contact_phone);
create index if not exists idx_client_companies_status on client_companies(status);

-- link trip requests to a company account (nullable: legacy/public requests have none)
alter table client_requests add column if not exists company_id uuid references client_companies(id);
create index if not exists idx_client_requests_company on client_requests(company_id);

-- RLS on: access only through the service role (edge function). No public policies.
alter table client_companies enable row level security;

-- public-read bucket for company logos
insert into storage.buckets (id, name, public)
values ('company-logos', 'company-logos', true)
on conflict (id) do nothing;
