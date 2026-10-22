-- نوع السكن (فندق/محمية) من عمود «Hotel Type» في شيت الوجهة (جنوب أفريقيا).
-- يُزامَن عبر sync-sheets، ويُستخدم في list_hotels لتصنيف/تصفية قائمة تبديل الفندق
-- (فندق/محمية/الكل) في شاشة التسعير. فارغ لأي فندق بلا تصنيف (يُعامَل «فندق»).
alter table hotels add column if not exists hotel_type text not null default '';
