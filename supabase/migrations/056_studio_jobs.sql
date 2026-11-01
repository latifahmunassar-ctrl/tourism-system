-- استوديو الفيديو: جدول مهام التجهيز + bucket رفع الملفات
-- (طُبّق على ofotvacszlmrqxzfjmtn؛ idempotent فيعاد تشغيله بأمان)

create table if not exists public.studio_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  account text not null default 'madar',
  destination text,
  title text,
  price text,
  duration text,
  steps jsonb not null default '{}'::jsonb,
  effects text[] not null default '{}',
  inputs jsonb not null default '[]'::jsonb,
  status text not null default 'pending',   -- pending | processing | done | failed
  output_url text,
  error text,
  claimed_at timestamptz
);

create index if not exists idx_studio_jobs_status on public.studio_jobs (status, created_at);

create or replace function public.studio_jobs_touch() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create or replace trigger trg_studio_jobs_touch before update on public.studio_jobs
  for each row execute function public.studio_jobs_touch();

alter table public.studio_jobs enable row level security;

do $$ begin
  create policy "studio_jobs_anon_read" on public.studio_jobs for select to anon using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "studio_jobs_anon_insert" on public.studio_jobs for insert to anon with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.studio_jobs;
exception when duplicate_object then null; end $$;

insert into storage.buckets (id, name, public)
values ('studio-uploads','studio-uploads', true)
on conflict (id) do update set public = true;

do $$ begin
  create policy "studio_uploads_anon_read" on storage.objects for select to anon using (bucket_id = 'studio-uploads');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "studio_uploads_anon_insert" on storage.objects for insert to anon with check (bucket_id = 'studio-uploads');
exception when duplicate_object then null; end $$;
