-- تتبّع مصدِّر الـ PDF: اسم الموظفة اللي صدّرت/حفظت البرنامج من المساعد السياحي.
-- يُملأ من alezz_staff_name بالمتصفح عبر دالة programs. العدّ يبدأ من الآن.
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS created_by text;
