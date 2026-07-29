-- سجل دخول الموظفات للمساعد السياحي: حدث لكل دخول بصمة ناجح (اسم + جهاز + وقت).
-- يُكتب من دالة webauthn عند auth_finish. العدّ يبدأ من الآن.
CREATE TABLE IF NOT EXISTS staff_login_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint,
  name         text,
  device_label text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_login_log_created_idx ON staff_login_log (created_at DESC);

-- الجدول يُكتب/يُقرأ عبر service_role فقط (دوال Edge)؛ نُفعّل RLS بلا سياسات عامة.
ALTER TABLE staff_login_log ENABLE ROW LEVEL SECURITY;
