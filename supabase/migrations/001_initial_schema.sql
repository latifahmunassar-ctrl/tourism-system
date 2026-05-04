-- ══════════════════════════════════════════════
-- نظام البرامج السياحية – هيكل قاعدة البيانات
-- ══════════════════════════════════════════════

-- الفنادق
CREATE TABLE IF NOT EXISTS hotels (
  id               UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  name             TEXT         NOT NULL,
  stars            INTEGER      NOT NULL DEFAULT 3,
  location         TEXT         NOT NULL DEFAULT '',
  price_per_night  DECIMAL(10,2) NOT NULL DEFAULT 0,
  room_type        TEXT         NOT NULL DEFAULT '',
  includes_breakfast BOOLEAN    NOT NULL DEFAULT false,
  currency         TEXT         NOT NULL DEFAULT 'SAR',
  last_synced_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(name, room_type)
);

-- الجولات والانتقالات
CREATE TABLE IF NOT EXISTS tours (
  id             UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  name           TEXT         NOT NULL UNIQUE,
  type           TEXT         NOT NULL DEFAULT '',
  price          DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency       TEXT         NOT NULL DEFAULT 'SAR',
  description    TEXT         NOT NULL DEFAULT '',
  last_synced_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- سجلات المزامنة
CREATE TABLE IF NOT EXISTS sync_logs (
  id             UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  synced_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status         TEXT         NOT NULL,
  hotels_synced  INTEGER      NOT NULL DEFAULT 0,
  tours_synced   INTEGER      NOT NULL DEFAULT 0,
  duration_ms    INTEGER      NOT NULL DEFAULT 0,
  error_message  TEXT
);

-- تأمين الجداول (قراءة/كتابة عبر Edge Functions فقط)
ALTER TABLE hotels    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tours     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
