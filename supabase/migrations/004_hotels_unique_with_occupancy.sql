-- نفس اسم الفندق + نفس نوع الغرفة قد يتكرّر بـ occupancies مختلفة
-- (مثلاً: "2 adults", "2 adults + 2 child", "4 adults") — كل واحدة تكلفة مختلفة.
-- لذلك نوسّع المفتاح الفريد ليشمل occupancy.
ALTER TABLE hotels DROP CONSTRAINT IF EXISTS hotels_name_room_type_key;
ALTER TABLE hotels ADD CONSTRAINT hotels_name_room_type_occupancy_key
  UNIQUE (name, room_type, occupancy);
