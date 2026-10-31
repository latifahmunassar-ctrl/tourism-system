-- عدد ليالي الباقة (أبوظبي / ياس آيلاند): الشيت يسعّر الباقة كاملةً لـ٢ أو ٣ أو ٤ ليالٍ
-- بدل سعر الليلة، والسعر غير خطّي (دوسِت: ليلتان 2291.99 = 1146/ليلة · ثلاث 3122.99 = 1041/ليلة)
-- فلا يمكن اشتقاقه بالقسمة. كل فندق × فترة يُنتج ثلاثة صفوف، واحد لكل مدّة.
-- NULL لكل الوجهات الأخرى = تسعير بالليلة كما هو، بلا أي تغيير في سلوكها.
alter table hotels add column if not exists nights int;

-- القيد الفريد القديم UNIQUE(name, room_type, occupancy, date_from) يمنع الصفوف
-- الثلاثة (٢/٣/٤ ليالٍ) لنفس الفندق والفترة. نستبدله بقيد يشمل عدد الليالي.
-- coalesce(nights,0) مقصود: NULL في فهرس فريد يُعتبر مميّزاً فيُبطل القيد عملياً
-- لكل الوجهات الأخرى — التحويل إلى 0 يُبقي سلوكها كما هو بالضبط.
alter table hotels drop constraint if exists hotels_name_room_type_occupancy_date_key;
create unique index if not exists hotels_name_room_occ_date_nights_key
  on hotels (name, room_type, occupancy, date_from, (coalesce(nights, 0)));
