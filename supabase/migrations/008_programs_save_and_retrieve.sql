-- حفظ/استرجاع البرامج عبر كود فريد مثل VN-2026-001

-- عدّاد تسلسلي لكل Prefix + سنة (لمنع التضارب)
CREATE TABLE IF NOT EXISTS program_counters (
  prefix    TEXT    NOT NULL,
  year      INTEGER NOT NULL,
  last_num  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);

ALTER TABLE program_counters ENABLE ROW LEVEL SECURITY;

-- توليد الكود التالي بشكل ذري (atomic) عبر UPSERT
CREATE OR REPLACE FUNCTION next_program_code(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  y INTEGER := EXTRACT(YEAR FROM NOW())::INTEGER;
  n INTEGER;
  pref TEXT := UPPER(TRIM(COALESCE(p_prefix, '')));
BEGIN
  IF pref = '' THEN
    pref := 'XX';
  END IF;

  INSERT INTO program_counters(prefix, year, last_num)
  VALUES (pref, y, 1)
  ON CONFLICT (prefix, year)
  DO UPDATE SET last_num = program_counters.last_num + 1
  RETURNING last_num INTO n;

  RETURN pref || '-' || y::TEXT || '-' || LPAD(n::TEXT, 3, '0');
END;
$$;

-- جدول البرامج المحفوظة
CREATE TABLE IF NOT EXISTS programs (
  id          UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  code        TEXT         NOT NULL UNIQUE,
  destination TEXT         NOT NULL,
  raw         TEXT         NOT NULL,
  pdf_variant TEXT         NOT NULL DEFAULT 'client',
  total_group DECIMAL(12,2),
  persons     INTEGER,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE programs ENABLE ROW LEVEL SECURITY;

