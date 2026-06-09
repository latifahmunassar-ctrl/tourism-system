-- أسعار صرف العملات من شيت "currency": code (OMR/USD/…)، الاسم العربي، والسعر
-- (السعر = كم ريال سعودي لكل وحدة من العملة؛ التحويل = الإجمالي ÷ rate).
CREATE TABLE IF NOT EXISTS currencies (
  id             UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  code           TEXT         NOT NULL,
  name_ar        TEXT         NOT NULL DEFAULT '',
  rate           NUMERIC      NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(code)
);
