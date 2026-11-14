-- 🛍️ فانسي سنس: طلبات تعديل/حذف من المحاسبين (محمد وآية) — ما ينطبق شي إلا بموافقة المالكة (١٤ نوفمبر ٢٠٢٦)
create table if not exists fs_change_requests (
  id bigserial primary key,
  tbl text not null,
  row_id bigint not null,
  action text not null check (action in ('update','delete')),
  old jsonb,
  new jsonb,
  reason text,
  requested_by text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  result text
);
create index if not exists fs_change_requests_status_idx on fs_change_requests(status, created_at desc);
alter table fs_change_requests enable row level security;   -- القراءة/الكتابة عبر الدالة فقط (service role)
