-- رابط صفحة الفندق (booking.com…) من عمود «links» في شيت الوجهة.
-- يُزامَن عبر sync-sheets، ويُعرض كرابط مختصر قابل للنقر «اضغط هنا لمشاهدة الفندق»
-- في ملف العميل (PDF) فقط. فارغ لأي فندق بلا رابط في الشيت.
alter table hotels add column if not exists link text not null default '';
