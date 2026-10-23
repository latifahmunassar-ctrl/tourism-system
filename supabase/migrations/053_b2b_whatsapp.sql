-- ══════════════════════════════════════════════════════════════════
-- B2B WhatsApp — شركات + حملات قوالب + محادثات سارة (B2B)
-- رقم الأعمال الجديد: +968 7554 2288
--   phone_number_id = 1323027874234661 · WABA = 1338474844901989
-- نفس تطبيق «Alezz chat final» ونفس توكن System User (Alezz Bot).
-- RLS مُفعّل بلا سياسات عامة: الوصول عبر دوال Edge بمفتاح الخدمة فقط
-- (نفس نمط 047 discovered_companies). لا علاقة لها برقم السياحة 9117 1630.
-- ══════════════════════════════════════════════════════════════════

-- الشركات (قاعدة الاستهداف)
create table if not exists b2b_companies (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  contact_name text,
  whatsapp     text,
  country      text,
  destinations text[],
  category     text,
  status       text default 'new',
  notes        text,
  created_at   timestamptz default now()
);

-- الحملات (قالب + فلاتر الاستهداف)
create table if not exists b2b_campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  template_name text,
  template_lang text default 'ar',
  filters       jsonb default '{}'::jsonb,
  status        text default 'draft',   -- draft | sending | sent | failed
  created_at    timestamptz default now()
);

-- رسائل الحملة (سطر لكل شركة + حالة التسليم)
create table if not exists b2b_campaign_messages (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid references b2b_campaigns(id) on delete cascade,
  company_id    uuid references b2b_companies(id) on delete cascade,
  wa_message_id text,
  status        text default 'pending', -- pending | sent | delivered | read | failed
  error         text,
  sent_at       timestamptz,
  updated_at    timestamptz default now()
);

-- المحادثات (قناة لكل رقم شركة) + مفتاح الرد التلقائي
create table if not exists b2b_conversations (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references b2b_companies(id) on delete set null,
  whatsapp        text unique,
  auto_reply      boolean default true,
  last_message_at timestamptz default now()
);

-- الرسائل (وارد/صادر لكل محادثة)
create table if not exists b2b_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references b2b_conversations(id) on delete cascade,
  direction       text check (direction in ('in','out')),
  body            text,
  wa_message_id   text,
  status          text,
  created_at      timestamptz default now()
);

-- إعدادات B2B (مفتاح/قيمة) — تخزين system prompt سارة وغيره
create table if not exists b2b_settings (
  key   text primary key,
  value text
);

-- فهارس
create index if not exists idx_b2b_campmsg_campaign  on b2b_campaign_messages(campaign_id);
create index if not exists idx_b2b_campmsg_wa        on b2b_campaign_messages(wa_message_id);
create index if not exists idx_b2b_messages_conv     on b2b_messages(conversation_id);
create index if not exists idx_b2b_conv_wa           on b2b_conversations(whatsapp);
create index if not exists idx_b2b_companies_country on b2b_companies(country);
create index if not exists idx_b2b_companies_category on b2b_companies(category);

-- RLS مغلق (الوصول عبر Edge بمفتاح الخدمة فقط)
alter table b2b_companies         enable row level security;
alter table b2b_campaigns         enable row level security;
alter table b2b_campaign_messages enable row level security;
alter table b2b_conversations     enable row level security;
alter table b2b_messages          enable row level security;
alter table b2b_settings          enable row level security;

-- system prompt الأولي لشخصية B2B «سارة» (قابل للتعديل من الواجهة لاحقاً).
-- المفتاح بقي talal_system_prompt لأن الدوال تقرؤه بهذا الاسم.
insert into b2b_settings (key, value) values (
  'talal_system_prompt',
  'أنتِ «سارة»، مندوبة شراكات في شركة العز الدولية للسفر والسياحة. تخاطبين شركات السياحة والسفر (B2B) بأسلوب مهني ودود وباللهجة الخليجية الراقية. مهمتك عند أول تواصل: ترحّبين بالشركة باسم العز، تسألين بلطف عن اسم الشركة واسم المسؤول، وتوضّحين أن مسؤول الشراكات في العز سيتواصل معهم قريباً لمناقشة التعاون. اجعلي ردودك مختصرة ومهنية، ولا تعطي أسعاراً أو وعوداً تفصيلية. لا تستخدمي Markdown ولا نجوم ولا عناوين — نص عادي فقط.'
) on conflict (key) do nothing;
