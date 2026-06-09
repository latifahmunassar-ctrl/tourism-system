-- تسعير الفنادق الموسمي (مثل خريف صلالة): نخزّن نطاق تاريخ لكل صف سعر،
-- ونُوسّع المفتاح الفريد ليشمل date_from حتى لا تنطمس صفوف المواسم
-- (نفس الفندق/الغرفة/الإشغال بسعرين مختلفين حسب الموسم).
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS date_from TEXT NOT NULL DEFAULT '';
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS date_to   TEXT NOT NULL DEFAULT '';

ALTER TABLE hotels DROP CONSTRAINT IF EXISTS hotels_name_room_type_occupancy_key;
ALTER TABLE hotels ADD CONSTRAINT hotels_name_room_type_occupancy_date_key
  UNIQUE (name, room_type, occupancy, date_from);
