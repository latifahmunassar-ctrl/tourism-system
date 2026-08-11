-- 047_discovered_companies.sql
-- قسم «اكتشاف شركات» — منفصل تماماً عن جدول الشركات الحالي (client_companies).
-- لا يلمس أي جدول قائم. جدولان جديدان فقط:
--   discovered_companies : نتائج الاكتشاف (شركة سفر/سياحة عامة من Google Places)
--   discovery_jobs       : حالة مهمة البحث الخلفية (queue + cursor للاستئناف)
-- RLS مفعّل بلا سياسة (مثل بقية جداول النظام) — الوصول عبر دالة Edge بمفتاح الخدمة فقط.

create table if not exists public.discovered_companies (
  id                    bigint generated always as identity primary key,
  job_id                uuid,
  place_id              text unique,                 -- مُعرّف Google Places (منع تكرار أساسي)
  name                  text,
  name_normalized       text,                        -- الاسم المطبّع (لكشف التكرار)
  website               text,
  domain                text,
  whatsapp_number       text,                        -- E.164
  whatsapp_confidence   text,                        -- 'confirmed' | 'likely'
  whatsapp_source       text,                        -- 'website' | 'places_mobile'
  phone_landline        text,                        -- أرضي مستبعَد من الواتساب
  instagram_handle      text,
  city                  text,
  country               text,                        -- SA/OM/AE/KW/QA/BH
  destination_match     boolean default false,
  destination_evidence  text,
  source_query          text,                        -- "المدينة × الكلمة"
  status                text default 'new',
  created_at            timestamptz default now()
);

create index if not exists idx_disc_job          on public.discovered_companies (job_id);
create index if not exists idx_disc_conf         on public.discovered_companies (whatsapp_confidence);
create index if not exists idx_disc_name_norm    on public.discovered_companies (name_normalized);
create index if not exists idx_disc_domain       on public.discovered_companies (domain);
create index if not exists idx_disc_instagram    on public.discovered_companies (instagram_handle);
create index if not exists idx_disc_created      on public.discovered_companies (created_at desc);

alter table public.discovered_companies enable row level security;

-- حالة المهمة الخلفية: تُحفظ تدريجياً ليكمل البحث من مكانه إذا انقطع.
create table if not exists public.discovery_jobs (
  id             uuid primary key default gen_random_uuid(),
  params         jsonb,                 -- {country, activity, scope, cities, destination, target, keywords}
  queue          jsonb default '[]'::jsonb,  -- [{city, keyword}] كل الاستعلامات المطلوبة
  cursor         int default 0,         -- مؤشر الاستعلام الحالي في queue (للاستئناف)
  found          int default 0,         -- إجمالي نتائج Places المرئية
  inserted       int default 0,         -- المُضاف فعلاً (بعد إزالة التكرار)
  duplicates     int default 0,         -- المكرر المحذوف
  target         int default 500,
  status         text default 'running',-- running | done | stopped | error
  current_label  text,                  -- "الرياض × وكالة سفر"
  error          text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create index if not exists idx_disc_jobs_status on public.discovery_jobs (status, created_at desc);

alter table public.discovery_jobs enable row level security;
