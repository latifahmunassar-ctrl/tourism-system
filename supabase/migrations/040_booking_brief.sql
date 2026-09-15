-- ══════════════════════════════════════════════
-- booking_brief — طلب فرد (B2C) مُعبّأ يدوياً من لوحة الواتساب
-- ══════════════════════════════════════════════
--
-- الموظف يقرأ محادثة العميل في لوحة الواتساب ويعبّئ فورماً يدوياً (لا استخراج
-- تلقائي ولا AI ولا regex)، ثم يحوّله فيظهر في «طلبات الأفراد» بصندوق الطلبات
-- (requests.html) منفصلاً عن طلبات الشركات (client_requests).
--
-- أسماء الحقول تطابق request.html للتحويل المباشر. بناء إضافي غير كاسر: جدول
-- جديد منفصل تماماً — لا يلمس whatsapp_sessions، ولا الراوتر، ولا client_requests.
--
-- RLS مغلق بلا سياسات: الوصول حصراً عبر service_role (الـ edge functions) الذي
-- يتجاوز RLS — نفس نمط تحصين client_requests وبقية جداول wa_/whatsapp_.

create table if not exists public.booking_brief (
  id                uuid        primary key default gen_random_uuid(),

  -- الرابط بالمحادثة: رقم العميل (يُملأ تلقائياً من المحادثة، للقراءة فقط في الفورم).
  -- ليس فريداً: العميل قد يقدّم أكثر من طلب عبر الوقت.
  contact_phone     text,

  -- مدخلات الفورم (أسماء مطابقة لـ request.html)
  destination       text,
  pax               integer,                 -- عدد البالغين
  children          integer,
  days              integer,
  date_from         date,
  arrival_airport   text,
  departure_airport text,
  sim_count         integer,
  hotel_stars       text,                    -- ٣ / ٤ / ٥ / غير محدد
  notes             text,

  -- حقول تلقائية
  handled_by        text,                    -- الموظف المسجّل دخوله الذي عبّأ الطلب
  currency          text,                    -- كشف تلقائي: +968→OMR، +966→SAR، غيرها→فارغ

  -- تمييز الأفراد عن الشركات في صندوق الطلبات الموحّد.
  request_type      text        not null default 'individual',  -- individual | company

  -- incomplete → complete (عند: وجهة + بالغين + أيام). قيم أبعد (transferred…)
  -- تُضاف في خطوات لاحقة عند ربط التحويل بصندوق الطلبات.
  status            text        not null default 'incomplete',

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_booking_brief_status on public.booking_brief (status, created_at desc);
create index if not exists idx_booking_brief_phone  on public.booking_brief (contact_phone);

comment on table public.booking_brief is
  'طلب فرد (B2C) مُعبّأ يدوياً من لوحة الواتساب — request_type=individual. منفصل عن client_requests. لا استخراج تلقائي.';

alter table public.booking_brief enable row level security;
