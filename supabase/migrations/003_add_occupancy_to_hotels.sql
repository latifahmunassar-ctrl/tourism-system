-- إضافة عمود Occupancy لجدول الفنادق
-- يحتوي وصف الإشغال كنص، مثل: "2 adults + 2 child"
ALTER TABLE hotels
  ADD COLUMN IF NOT EXISTS occupancy TEXT NOT NULL DEFAULT '';
