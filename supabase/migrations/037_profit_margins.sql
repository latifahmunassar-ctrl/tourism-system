-- جدول هوامش الأرباح لكل وجهة: نطاق التكلفة الإجمالية → ربح الشركات وربح الأفراد.
-- يُملأ من عمود «شركات/آفراد» في كل شيت وجهة عبر المزامنة (full-replace per destination).
CREATE TABLE IF NOT EXISTS profit_margins (
  id                UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  destination       TEXT         NOT NULL,
  cost_min          NUMERIC      NOT NULL DEFAULT 0,
  cost_max          NUMERIC      NOT NULL DEFAULT 0,
  profit_company    NUMERIC      NOT NULL DEFAULT 0,
  profit_individual NUMERIC      NOT NULL DEFAULT 0,
  last_synced_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS profit_margins_dest_idx ON profit_margins(destination);
