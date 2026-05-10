-- قطارات بين المدن: سعر للشخص (مثل الطيران الداخلي) — يُضرب في عدد المسافرين في الواجهة.
CREATE TABLE IF NOT EXISTS trains (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  from_city       TEXT         NOT NULL,
  to_city         TEXT         NOT NULL,
  price_per_pax   DECIMAL(10,2) NOT NULL,
  currency        TEXT         NOT NULL DEFAULT 'SAR',
  destination     TEXT         NOT NULL,
  last_synced_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (from_city, to_city, destination)
);

ALTER TABLE trains ENABLE ROW LEVEL SECURITY;
