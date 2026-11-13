-- تيكتات المشاكل — منال (قسم الشركات) تفتح تيكت لما ما تقدر تلبّي طلب بسبب نقص بالبيانات
-- (مثلاً: ما فيه غرف لـ ٤ أشخاص في أبود إلا فلل). تظهر في جروب الواتساب برقمها وفي
-- تبويب «🎫 التيكتات» بالمساعد السياحي (team.html) عشان الإدارة ترجع لها وتحلها.
-- الوصول فقط عبر الدالة Tourism-AI (service role)؛ RLS مفعّل بدون سياسات = مغلق للعامة.
create table if not exists public.support_tickets (
  id bigserial primary key,
  ticket_no text unique,
  created_at timestamptz not null default now(),
  source text not null default 'manal',
  kind text,                 -- مثل no_room_capacity
  dedupe_key text,           -- نفس المشكلة المفتوحة ما تتكرر (نفس الوجهة/المنطقة/السعة)
  dest text,
  area text,
  problem text not null,
  request_text text,
  employee text,
  group_jid text,
  program_code text,
  status text not null default 'open',   -- open | resolved
  resolution text,
  resolved_at timestamptz,
  hits int not null default 1           -- كم مرة تكررت نفس المشكلة
);
create index if not exists support_tickets_status_idx on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_dedupe_idx on public.support_tickets (dedupe_key) where status = 'open';
alter table public.support_tickets enable row level security;
