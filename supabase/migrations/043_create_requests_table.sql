create table public.requests (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('company','staff')),
  group_jid text,
  sender_name text,
  raw_text text not null,
  destination text,
  travel_dates text,
  pax text,
  budget text,
  company_name text,
  status text not null default 'new'
    check (status in ('new','needs_review','ready','done')),
  created_at timestamptz not null default now()
);

alter table public.requests enable row level security;

create policy "staff_read_requests"
on public.requests for select
to authenticated using (true);

create policy "staff_update_requests"
on public.requests for update
to authenticated using (true);
