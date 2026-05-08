-- كود عميل داخل النص (مثل CLIENT_CODE:ALZ-2026-001) للاسترجاع بجانب الكود الآلي VN-2026-001
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS client_code TEXT;

CREATE INDEX IF NOT EXISTS programs_client_code_idx ON programs ((lower(client_code)));
