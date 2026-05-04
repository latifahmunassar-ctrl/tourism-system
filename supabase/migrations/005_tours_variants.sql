-- إضافة قائمة الـ price variants للجولات
-- كل عنصر يحتوي: { label: "1-3 Pax" أو "may month", price: number, currency: string }
-- النموذج يختار الـ variant المناسب حسب عدد الأشخاص أو شهر السفر.
ALTER TABLE tours
  ADD COLUMN IF NOT EXISTS variants JSONB NOT NULL DEFAULT '[]'::jsonb;
