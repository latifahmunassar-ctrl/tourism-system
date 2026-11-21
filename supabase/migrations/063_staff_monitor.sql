-- 🕘 الحضور والمخالفات (طلب المالكة ٢١ نوفمبر ٢٠٢٦)
-- جدول دوام الموظفات (توقيت عُمان) + الإجازات/الأذونات + سجل المخالفات.
-- الحارس (601) يسجّل المخالفة عند التذكير العاشر بلا رد عبر دالة staff-monitor.

create table if not exists staff_schedule (
  id            bigserial primary key,
  name          text not null,
  phone         text,                       -- أرقام فقط بصيغة دولية (201011346081)
  active        boolean not null default true,
  shift1_start  text,                       -- 'HH:MM' بتوقيت عُمان
  shift1_end    text,
  shift2_start  text,
  shift2_end    text,
  work_days     int[] default '{0,1,2,3,4,5,6}',  -- 0=الأحد … 6=السبت
  violation_group text,                     -- اسم قروب مخالفات الموظفة (فيه هي + المالكة + المحاسب)
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists staff_leaves (
  id          bigserial primary key,
  staff_id    bigint not null references staff_schedule(id) on delete cascade,
  kind        text not null default 'إجازة',   -- إجازة / إذن انصراف / تفرّغ
  from_ts     timestamptz,
  to_ts       timestamptz,
  status      text not null default 'pending', -- pending / approved / rejected
  request_text text,
  source      text default 'dashboard',        -- dashboard / whatsapp
  requested_at timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text,
  msg_id      text,                            -- مفتاح رسالة الطلب في قروب الموظفة (للموافقة بالرد)
  note        text
);
create index if not exists staff_leaves_staff_idx on staff_leaves(staff_id, from_ts);

create table if not exists staff_violations (
  id            bigserial primary key,
  staff_id      bigint references staff_schedule(id) on delete set null,
  staff_name    text not null,
  occurred_at   timestamptz not null default now(),   -- وقت التذكير العاشر
  received_at   timestamptz,                          -- وقت وصول الطلب/التعديل
  kind          text not null default 'رد',           -- رد / تعديل
  company       text,
  request_summary text,
  request_key   text not null,
  reason        text,                                 -- لم يستلمه أحد / استلمته ولم ترد
  amount        numeric not null default 10,
  currency      text not null default 'SAR',
  status        text not null default 'applied',      -- applied / not_applied_leave / under_review / cancelled
  leave_id      bigint references staff_leaves(id) on delete set null,
  objection_text text,
  objection_media boolean default false,
  objection_at  timestamptz,
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  notice_msg_id text,                                 -- مفتاح رسالة الإشعار في قروب الموظفة (للرد عليها بالاعتراض)
  created_at    timestamptz not null default now(),
  unique (staff_id, request_key)
);
create index if not exists staff_violations_time_idx on staff_violations(occurred_at desc);

-- صندوق رسائل قروبات الموظفات (الحارس يسحبها ويرسلها كل دقيقة)
create table if not exists staff_notices (
  id           bigserial primary key,
  staff_id     bigint references staff_schedule(id) on delete cascade,
  violation_id bigint references staff_violations(id) on delete set null,
  leave_id     bigint references staff_leaves(id) on delete set null,
  body         text not null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  msg_id       text
);
create index if not exists staff_notices_unsent_idx on staff_notices(sent_at) where sent_at is null;

alter table staff_notices   enable row level security;
alter table staff_schedule  enable row level security;
alter table staff_leaves    enable row level security;
alter table staff_violations enable row level security;
-- لا سياسات = لا وصول إلا لمفتاح الخدمة (الدوال فقط)

insert into acc_config(key, value) values
  ('sm_enabled', 'false'),
  ('sm_fine_amount', '10'),
  ('sm_fine_currency', 'SAR'),
  ('sm_edit_group', '')
on conflict (key) do nothing;
