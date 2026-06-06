-- ══════════════════════════════════════════════
-- tours.city — canonical city a tour belongs to
-- ══════════════════════════════════════════════
--
-- Tours in the Google Sheet are grouped under per-city section headers
-- (e.g. "جولات وانتقالات اسطنبول" then all Istanbul day-trips, then
-- "طرابزون" then Trabzon tours). Many day-trips (سابانجا، بورصة، الأميرات،
-- فيالاند، فينيسيا) never name their owning city, so name-only matching in
-- the builder dropped them. sync-sheets now tracks the section header and
-- stamps each tour with its canonical city; the builder prefers this column
-- and only falls back to name-regex when it's empty (legacy rows / sheets
-- without section headers).
--
-- Empty string = unknown city → builder uses the name-regex fallback, so
-- existing behaviour is preserved for any tour not under a section header.

ALTER TABLE tours ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
