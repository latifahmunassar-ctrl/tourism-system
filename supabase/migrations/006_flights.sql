-- جدول الطيران: من/إلى/السعر للشخص الواحد
-- السعر للشخص الواحد دائماً ويُضرب في عدد الأشخاص.
CREATE TABLE IF NOT EXISTS flights (
  id              UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  from_city       TEXT         NOT NULL,
  to_city         TEXT         NOT NULL,
  price_per_pax   DECIMAL(10,2) NOT NULL,
  currency        TEXT         NOT NULL DEFAULT 'SAR',
  destination     TEXT         NOT NULL,
  last_synced_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (from_city, to_city, destination)
);
