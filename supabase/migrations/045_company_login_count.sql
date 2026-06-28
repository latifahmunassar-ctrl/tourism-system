-- عدّاد دخول الشركات عبر المنصة + آخر دخول (لتبويب «سجل الدخول» في داشبورد الشركات).
-- العدّ يبدأ من الآن؛ الدخولات السابقة لم تكن تُسجَّل لكل شركة.
ALTER TABLE client_companies
  ADD COLUMN IF NOT EXISTS login_count  integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
