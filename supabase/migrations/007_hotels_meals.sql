-- إضافة عمود meals (نص حر) لتخزين تفاصيل ما يشمله الفندق
-- (إفطار، إفطار + غداء، جميع الوجبات، إلخ)
ALTER TABLE hotels
  ADD COLUMN IF NOT EXISTS meals TEXT NOT NULL DEFAULT '';
