-- مكتبة العروض المشتركة: الأدمن يرفع ملفات PDF مصنّفة، والموظف يرسلها للعميل
-- من أي محادثة. category = الزر الرئيسي (عمان/السعودية)، label = اسم الوجهة
-- داخل القائمة (ماليزيا/اندونيسيا/...).
create table if not exists wa_offers (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  label text not null,
  file_url text not null,
  storage_key text,
  content_type text,
  file_size bigint,
  uploaded_by text,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists wa_offers_active_cat_idx
  on wa_offers (active, category, sort, created_at);
