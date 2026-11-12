-- Fancy Sense — نظام المصروفات والمنتجات (fancy-books.html) — مخزن مستندات مشترك
-- الوصول فقط عبر الدالة fs-books (service role)؛ RLS مفعّل بدون سياسات = مغلق للعامة
create table if not exists public.fs_app_docs (
  coll text not null,
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (coll, id)
);
create index if not exists fs_app_docs_updated_idx on public.fs_app_docs (updated_at);
alter table public.fs_app_docs enable row level security;
